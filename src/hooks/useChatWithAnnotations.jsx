import * as React from 'react'
import { useChat } from 'ai/react'
import { appendChatAnnotation, finalizePending } from '@/lib/runtimeAnnotations'
import {
  MAX_CONCURRENT_STREAMS,
  tryAcquireStream,
  releaseStream,
} from '@/lib/streamGate'
import { child } from '@/lib/logger'

const log = child('chat')

/**
 * useChatWithAnnotations —— 把后端 `2:` annotation 行写入 runtimeAnnotations，
 * 并在 StreamingMessage 渲染时查出来，避免被 useChat 流式分片覆盖。
 *
 * ⚠️ 为什么必须在这里拦截而不是让 SDK 处理（2026-08 排查结论）：
 *  本项目用的 ai@3.4 / @ai-sdk/ui-utils 数据流协议里，`2:` 是 **data part**——
 *  只进 useChat 返回的 `chat.data`（无组件消费），而 `message.annotations` 对应的
 *  协议码是 `8:`。后端统一发 `2:`（AI SDK 服务端 toDataStream 的注解码），
 *  因此注解必须由本 hook 的 fetch wrapper 从流里剥出来写进 runtimeAnnotations：
 *   - 面试检索 / opReport 流：注解在流头部（首行）→ 旧版只拦首行也能工作
 *   - ReAct 流：注解夹在思考文本**之后**（每步工具执行完发一条）→ 必须全流过滤
 *  否则 ReAct 的工作流卡片（agent_workflow）在 UI 上永远不显示。
 *
 *  多注解累积：一轮回复可能含多条 `2:` 行（ReAct 每步一条 + FINISH 一条），
 *  逐条累积进 `__pending__`，由 finalize effect 在 assistant 消息出现后合并定版。
 */
export function useChatWithAnnotations(options) {
  const chatId = options?.id ?? '__default__'
  const userFetch = options?.fetch
  const userOnData = options?.onData
  const userOnResponse = options?.onResponse

  // 这一轮回复是否已经写过 annotation（true 表示有 pending 注解待定版/待合并）
  const writtenRef = React.useRef(false)

  // 跟踪最新的 messages（渲染期间同步写入），在各处都能直接读
  const messagesRef = React.useRef([])

  // 一轮可能收到多条 2: 行（ReAct 每步一条）：逐条累积进 __pending__（内部合并）
  const writeAnnot = (payload) => {
    let data = payload
    if (!Array.isArray(data) && data && typeof data === 'object') data = [data]
    if (!Array.isArray(data) || data.length === 0) return
    appendChatAnnotation(chatId, data) // 不猜 messageId → 合并进 __pending__
    writtenRef.current = true
  }

  const chat = useChat({
    ...options,
    ...(userOnData ? { onData: userOnData } : {}),

    // 1) 拦截 fetch：全流逐行过滤 `2:` annotation 行 → 写入 runtimeAnnotations；
    //    其余字节（0: 文本 / d: 结束等）原样转发给 SDK。
    //    注：SDK 对 `2:` 行只会塞进无人消费的 chat.data（data part），必须在此剥离。
    // 2) 并行流上界（M4/ADR-008）：发送前抢槽位，超上限直接抛错让 useChat 进 error 态；
    //    结束（完成/中止/出错）时释放。槽位泄漏防护：每个 return / throw 路径都 release。
    fetch: async (input, init) => {
      if (!tryAcquireStream()) {
        throw new Error(
          `已达到并行流上限（${MAX_CONCURRENT_STREAMS}），请等待某个对话结束，或先停止其中一个`,
        )
      }
      let released = false
      const release = () => {
        if (released) return
        released = true
        releaseStream()
      }

      let resp
      try {
        resp = userFetch
          ? await userFetch(input, init)
          : await fetch(input, init)
      } catch (err) {
        release()
        throw err
      }
      try {
        userOnResponse?.(resp)
      } catch (err) {
        log.error('[useChatWithAnnotations] onResponse 回调异常：', err)
      }
      if (!resp.body || resp.status >= 400) {
        release()
        return resp
      }

      // 新请求开始 → 重置一轮内的开关
      writtenRef.current = false

      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      const encoder = new TextEncoder()
      let lineBuf = '' // 跨网络分片的不完整行缓冲

      const stream = new ReadableStream({
        async pull(controller) {
          const { done, value } = await reader.read()
          if (done) {
            // 流结束：处理残留缓冲（协议上每行都应以 \n 结尾，此处兜底）
            if (lineBuf) {
              if (lineBuf.startsWith('2:')) {
                try {
                  writeAnnot(JSON.parse(lineBuf.slice(2)))
                } catch (err) {
                  log.error(
                    '[useChatWithAnnotations] annotation 行解析失败：',
                    { line: lineBuf.slice(0, 200), err },
                  )
                }
              } else {
                controller.enqueue(encoder.encode(lineBuf))
              }
            }
            release()
            controller.close()
            return
          }
          const text = lineBuf + decoder.decode(value, { stream: true })
          const lines = text.split('\n')
          lineBuf = lines.pop() ?? '' // 最后一段可能不完整，留待下个分片
          for (const line of lines) {
            if (line.startsWith('2:')) {
              try {
                writeAnnot(JSON.parse(line.slice(2)))
              } catch (err) {
                // 不是合法 JSON 的 `2:` 行：不当注解处理，原样转发给 SDK
                log.error('[useChatWithAnnotations] annotation 行解析失败：', {
                  line: line.slice(0, 200),
                  err,
                })
                controller.enqueue(encoder.encode(`${line}\n`))
              }
            } else {
              controller.enqueue(encoder.encode(`${line}\n`))
            }
          }
        },
        async cancel(reason) {
          release()
          await reader.cancel(reason)
        },
      })

      return new Response(stream, {
        status: resp.status,
        statusText: resp.statusText,
        headers: resp.headers,
      })
    },
  })

  const { messages, isLoading } = chat

  // 保持 ref 最新（渲染期间同步，保证后面的 useEffect 读到的是同步值）
  messagesRef.current = messages

  // 🔑 关键 effect：等 SDK 把这轮的 assistant 占位消息真正 append 到 messages 之后，
  // 再把 __pending__ 按精确的 messageId + assistantIndex 定版写入双索引。
  // ReAct 流的注解分布在整轮（每步工具一条），此 effect 会随 messages 变化多次触发：
  // finalizePending 内部为"合并"语义——有新 pending 就并入该消息的已定版条目，
  // 没有 pending 则 no-op，因此无需防重标志。
  React.useEffect(() => {
    const msgs = messagesRef.current || []
    let lastAssistant = null
    let assistantCount = 0
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i]?.role === 'assistant') {
        assistantCount++
        lastAssistant = msgs[i]
      }
    }
    if (!lastAssistant?.id) return
    if (!writtenRef.current) return

    finalizePending(chatId, lastAssistant.id, assistantCount - 1)
    // chatId / messages 变化时都应该再判断一次
  }, [chatId, messages, isLoading])

  // 一轮对话完全结束（isLoading → false）：复位开关，下一轮回复可继续写 annotation。
  // 注意：finalize effect 定义在前，同一次 commit 内先执行（残留 pending 仍会被定版）。
  React.useEffect(() => {
    if (!isLoading) {
      writtenRef.current = false
    }
  }, [isLoading])

  const pauseAnnotationsClear = React.useCallback(() => {}, [])
  const resumeAnnotationsClear = React.useCallback(() => {}, [])

  return {
    ...chat,
    pauseAnnotationsClear,
    resumeAnnotationsClear,
  }
}

export default useChatWithAnnotations
