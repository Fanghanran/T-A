import * as React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Bot, User, Star, Volume2, Square } from 'lucide-react'
import { cn } from '@/lib/utils'
import { request } from '@/lib/api'
import { SearchProcessPanel } from './SearchProcessPanel'
import { ChunkPreviewPanel } from './ChunkPreviewPanel'
import { AgentWorkflowPanel } from './AgentWorkflowPanel'
import { ResumeReportPanel } from './ResumeReportPanel'
import { InterviewScorecardPanel } from './InterviewScorecardPanel'
import { getAnnotationForMessage } from '@/lib/runtimeAnnotations'
import { child } from '@/lib/logger'

const log = child('chat')

/**
 * StreamingMessage —— 单条消息气泡
 *
 * 行为：
 * - 用户消息靠右、主色调；AI 消息靠左、卡片色。
 * - AI 消息内容用 react-markdown 渲染，支持 GFM（表格、删除线等）。
 * - 流式生成中（streaming=true）时，末尾追加打字光标。
 * - 如果 assistant 消息**自带** `annotations`，或 runtimeAnnotations 里
 *   按 (chatId, allMessages, msgIndex) 能查到本轮 Recall 注解（面试题检索/知识库RAG
 *   命中结果），则在正文之前渲染 SearchProcessPanel，实现"👁 显示运行过程 +
 *   Recall slice X"风格的独立卡片。
 *
 * 为什么要读 runtimeAnnotations（不只用 message.annotations）：
 *   SDK useChat 在流式每个分片会重写最后一条 assistant，导致手动打进 messages 的
 *   annotations 字段瞬间被覆盖；改为在渲染时从独立 Map（按"第几个 assistant 回复"
 *   去匹配轮次）查表合并，就不会丢了。
 *
 * @param {Object} props
 * @param {import('ai').Message} props.message  当前消息对象
 * @param {boolean} [props.streaming]            是否正在流式输出该条消息
 * @param {Array}  [props.allMessages]           父层 messages 数组（用来数"第几个 assistant"）
 * @param {string} [props.chatId]                所属 useChat id / 智能体 id（查表用）
 * @param {number} [props.msgIndex]              在 messages 数组里的下标（查表用）
 * @param {(instruction:string, docId:string)=>void} [props.onAdjust]  切片调整指令回调；
 *        仅在 doc-processor 需要，透传给 ChunkPreviewPanel；不传则面板为纯只读展示。
 */
export function StreamingMessage({
  message,
  streaming = false,
  allMessages,
  chatId,
  msgIndex,
  onAdjust,
}) {
  const isUser = message.role === 'user'
  const [favState, setFavState] = React.useState('idle') // idle | saving | saved

  // 语音播报（浏览器内置 SpeechSynthesis，零后端依赖；中文音库优先）
  const [speaking, setSpeaking] = React.useState(false)
  // 组件卸载时停止朗读，避免切会话后语音继续
  React.useEffect(() => () => window.speechSynthesis?.cancel(), [])
  const speakMessage = () => {
    const synth = window.speechSynthesis
    if (!synth) return
    if (speaking) {
      synth.cancel()
      setSpeaking(false)
      return
    }
    const plain = String(message.content ?? '')
      .replace(/```[\s\S]*?```/g, '（代码块）')
      .replace(/[#*`>|]/g, '')
      .slice(0, 3000)
    const utter = new SpeechSynthesisUtterance(plain)
    const zhVoice = synth.getVoices().find((v) => v.lang?.toLowerCase().startsWith('zh'))
    if (zhVoice) utter.voice = zhVoice
    utter.onend = () => setSpeaking(false)
    utter.onerror = () => setSpeaking(false)
    synth.speak(utter)
    setSpeaking(true)
  }

  // 收藏本条回答到错题本（跨会话个人复习集）
  const saveFavorite = async () => {
    if (favState !== 'idle' || isUser) return
    setFavState('saving')
    try {
      await request('/api/favorites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: chatId,
          messageId: message.id,
          title: (message.content || '').replace(/[#*`>\-]/g, '').trim().slice(0, 60) || '收藏的回答',
          content: message.content || '',
        }),
      })
      setFavState('saved')
    } catch (err) {
      setFavState('idle')
      log.error('[favorite] 收藏失败', err)
    }
  }

  // ① useChat 可能会把 data-stream 中的 2: 行注入到 annotations；兼容 experimental_attachments
  // ② runtimeAnnotations 查到的（useChat 之外手动缓存的 search_results Recall 过程元数据）
  // message.annotations 引用每轮稳定（useChat 原地更新同一数组），
  // 包 useMemo 稳定下游 useMemo 的依赖，避免每次渲染重算
  const baseAnnotations = React.useMemo(
    () => message.annotations || message.experimental_attachments || [],
    [message.annotations, message.experimental_attachments],
  )
  const runtime = React.useMemo(
    () =>
      isUser ? null : getAnnotationForMessage(chatId, allMessages, msgIndex),
    [isUser, chatId, allMessages, msgIndex],
  )
  const annotations = React.useMemo(() => {
    if (!baseAnnotations.length && !runtime) return []
    const merged = []
    if (runtime?.length) merged.push(...runtime)
    if (baseAnnotations.length) merged.push(...baseAnnotations)
    // 去重：同一条注解可能同时来自 runtimeAnnotations 和 SDK 的 message.annotations
    //  - search_results：按 engine+total+query 粗略去重
    //  - agent_workflow：按 tool+seq 去重（ReAct 流走 SDK 路径、opReport 流走 runtime
    //    路径，两条路径若同时命中同一步骤，时间线里会出现重复节点）
    const seen = new Set()
    return merged.filter((a) => {
      if (!a) return false
      if (a.type === 'agent_workflow') {
        const k = `wf_${a.engine ?? ''}_${a.tool ?? ''}_${a.seq ?? ''}`
        if (seen.has(k)) return false
        seen.add(k)
        return true
      }
      if (a.type !== 'search_results') return true
      const k = `${a.engine ?? ''}_${a.total ?? ''}_${String(a.query ?? '')}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
  }, [baseAnnotations, runtime])

  // 文档处理智能体的注解分三路渲染：
  //  1. agent_workflow（工具调用时间线）→ AgentWorkflowPanel
  //  2. engine=doc-processor 的 search_results（切片结果）→ ChunkPreviewPanel
  //  3. 其余引擎（结构化题库 / 知识库语义）→ SearchProcessPanel
  const {
    workflowAnnotations,
    docAnnotations,
    searchAnnotations,
    resumeAnnotations,
    interviewAnnotations,
  } = React.useMemo(() => {
    const wf = []
    const doc = []
    const search = []
    const resume = []
    const interview = []
    for (const a of annotations) {
      if (a?.type === 'agent_workflow') wf.push(a)
      else if (a?.type === 'resume_report') resume.push(a)
      else if (a?.type === 'interview_scorecard') interview.push(a)
      else if (a?.engine === 'doc-processor') doc.push(a)
      else search.push(a)
    }
    return {
      workflowAnnotations: wf,
      docAnnotations: doc,
      searchAnnotations: search,
      resumeAnnotations: resume,
      interviewAnnotations: interview,
    }
  }, [annotations])

  // 回调包装：把本条预览注解里的 docId 一并回传给调用方。
  // 后端 adjust 用 `docId || '__ephemeral__'` 作切片缓存 key，指令不带 docId 会
  // 落到错误的缓存（甚至把指令文本当正文重新切片），所以这里从注解里取真实 docId。
  const docId = docAnnotations.find((a) => a?.docId)?.docId ?? ''
  const handleAdjust = React.useMemo(() => {
    if (typeof onAdjust !== 'function') return undefined
    return (instruction) => onAdjust(instruction, docId)
  }, [onAdjust, docId])

  // 调试日志：logger.debug 已内置 DEV 门控（生产构建会被剔除）
  if (!isUser) {
    log.debug('[StreamingMessage]', {
      msgIndex,
      chatId,
      msgRole: message.role,
      baseAnnotationsCount: baseAnnotations.length,
      baseAnnotationsTypes: baseAnnotations.map((a) => a?.type),
      runtimeFound: !!runtime,
      runtimeCount: runtime?.length || 0,
      runtimeTypes: runtime?.map((a) => a?.type) || [],
      runtimeEngines: runtime?.map((a) => a?.engine) || [],
      runtimeResultsLengths: runtime?.map((a) => a?.results?.length || 0) || [],
      finalAnnotationsCount: annotations.length,
      finalEngines: annotations.map((a) => a?.engine),
      finalResultsLengths: annotations.map((a) => a?.results?.length || 0),
      allMessagesCount: allMessages?.length || 0,
      nthAssistant: (() => {
        let n = 0
        for (let i = 0; i < msgIndex; i++)
          if (allMessages?.[i]?.role === 'assistant') n++
        return n
      })(),
    })
  }

  return (
    <div
      className={cn(
        'group/message flex w-full gap-3 animate-fade-in',
        isUser ? 'justify-end' : 'justify-start',
      )}
    >
      {!isUser && (
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-soft">
          <Bot className="h-4 w-4" />
        </div>
      )}

      <div className="max-w-[85%] sm:max-w-[75%] min-w-0 flex flex-col items-end sm:items-start">
        {!isUser && workflowAnnotations.length > 0 && (
          <div className="w-full">
            <AgentWorkflowPanel annotations={workflowAnnotations} />
          </div>
        )}

        {!isUser && docAnnotations.length > 0 && (
          <div className="w-full">
            <ChunkPreviewPanel
              annotations={docAnnotations}
              onAdjust={handleAdjust}
            />
          </div>
        )}

        {!isUser && searchAnnotations.length > 0 && (
          <div className="w-full">
            <SearchProcessPanel annotations={searchAnnotations} />
          </div>
        )}

        {!isUser && resumeAnnotations.length > 0 && (
          <div className="w-full">
            <ResumeReportPanel annotations={resumeAnnotations} />
          </div>
        )}

        {!isUser && interviewAnnotations.length > 0 && (
          <div className="w-full">
            <InterviewScorecardPanel annotations={interviewAnnotations} />
          </div>
        )}

        <div
          className={cn(
            'w-fit max-w-full rounded-2xl px-4 py-2.5 text-sm leading-relaxed',
            isUser
              ? 'bg-primary text-primary-foreground shadow-soft rounded-br-md'
              : 'border border-border/60 bg-card text-foreground shadow-soft rounded-bl-md',
          )}
        >
          {isUser ? (
            <p className="whitespace-pre-wrap break-words">{message.content}</p>
          ) : (
            <div className="prose-chat">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {message.content || (streaming ? '' : '…')}
              </ReactMarkdown>
              {streaming && (
                <span className="ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 bg-current animate-pulse" />
              )}
            </div>
          )}
          {!isUser && !streaming && message.content && (
            <div className="mt-1 flex justify-end gap-1">
              <button
                type="button"
                onClick={speakMessage}
                title={speaking ? '停止朗读' : '朗读回答'}
                className={cn(
                  'rounded p-1 text-[10px] text-muted-foreground opacity-0 transition-opacity group-hover/message:opacity-100 hover:text-foreground',
                  speaking && 'opacity-100 text-primary',
                )}
              >
                {speaking ? <Square className="h-3 w-3" /> : <Volume2 className="h-3.5 w-3.5" />}
              </button>
              <button
                type="button"
                onClick={saveFavorite}
                disabled={favState === 'saving'}
                title={favState === 'saved' ? '已收藏到错题本' : '收藏到错题本'}
                className={cn(
                  'rounded p-1 text-[10px] text-muted-foreground opacity-0 transition-opacity group-hover/message:opacity-100 hover:text-foreground',
                  favState === 'saved' && 'opacity-100 text-amber-500',
                )}
              >
                <Star
                  className={cn('h-3.5 w-3.5', favState !== 'idle' && 'fill-current')}
                />
              </button>
            </div>
          )}
        </div>
      </div>

      {isUser && (
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-secondary text-secondary-foreground">
          <User className="h-4 w-4" />
        </div>
      )}
    </div>
  )
}

export default StreamingMessage
