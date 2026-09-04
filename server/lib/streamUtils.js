/**
 * streamUtils —— AI SDK data-stream 协议流式输出工具
 *
 * 依赖层：L0（无内部依赖）
 *
 * 统一 stubStream / prependAnnotation 实现，消除 llm.js 与 docProcessor.js 的重复。
 */

const encoder = new TextEncoder()

/**
 * stub 流：按 AI SDK data-stream 协议（0:"text"\n + d:done）逐段输出确定文本。
 * 用于 LLM 不可用时的降级响应，或无需 LLM 的确定性文本输出。
 *
 * @param {string} text  要流式输出的文本（非字符串会被静默转为空串）
 * @returns {ReadableStream<Uint8Array>}
 */
export function stubStream(text) {
  const safe = typeof text === 'string' ? text : ''
  const segments = safe.match(/[\s\S]{1,4}/g) ?? []
  return new ReadableStream({
    async start(controller) {
      for (const seg of segments) {
        controller.enqueue(encoder.encode(`0:${JSON.stringify(seg)}\n`))
        await new Promise((r) => setTimeout(r, 10))
      }
      controller.enqueue(
        encoder.encode(
          `d:{"finishReason":"stop","usage":{"promptTokens":0,"completionTokens":0}}\n`,
        ),
      )
      controller.close()
    },
  })
}

/**
 * 在 AI SDK data-stream 最前面"插队"注入一条 2: 注解行（message annotations）。
 * 前端 useChat 收到后会把它挂在 assistant message.annotations 数组上；
 * 支持 1 个或多个 annotation 对象同时塞进去（一行 2:[{},{}]）。
 *
 * @param {ReadableStream<Uint8Array>} innerStream  原始流
 * @param {object|object[]} annotation              注解对象或数组
 * @returns {ReadableStream<Uint8Array>}
 */
export function prependAnnotation(innerStream, annotation) {
  const list = Array.isArray(annotation) ? annotation : [annotation]
  if (list.length === 0) return innerStream
  const prefix = encoder.encode(`2:${JSON.stringify(list)}\n`)
  let prefixSent = false
  const reader = innerStream.getReader()
  return new ReadableStream({
    async pull(controller) {
      if (!prefixSent) {
        prefixSent = true
        controller.enqueue(prefix)
        return
      }
      const { done, value } = await reader.read()
      if (done) controller.close()
      else controller.enqueue(value)
    },
    async cancel(reason) {
      await reader.cancel(reason)
    },
  })
}
