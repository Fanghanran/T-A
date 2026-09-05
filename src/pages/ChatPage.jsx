import * as React from 'react'
import { MessageList } from '@/components/chat/MessageList'
import { ChatInput } from '@/components/chat/ChatInput'
import { SessionSidebar } from '@/components/chat/SessionSidebar'
import { DocActionBar } from '@/components/chat/DocActionBar'
import { DocPreviewDialog } from '@/components/chat/DocPreviewDialog'
import { DocExportDialog } from '@/components/chat/DocExportDialog'
import { useSessionList } from '@/hooks/useChatSessions'
import { useChatHistory } from '@/hooks/useChatHistory'
import { useDocProcessor } from '@/hooks/useDocProcessor'
import { useAgentChat } from '@/hooks/useAgentChat'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { child } from '@/lib/logger'

const log = child('chat')

/**
 * ChatPage —— 聊天视图（左侧会话列表 + 右侧对话区）
 *
 * 纯视图组合：业务逻辑全部在 Hook 中 ——
 *   useSessionList   会话 CRUD + x-session-id 延迟切换
 *   useAgentChat     流式聊天（Vercel AI SDK 封装）
 *   useChatHistory   切换会话拉历史消息 + 注解恢复
 *   useDocProcessor  文档处理智能体的操作栏 REST 编排
 *
 * M4 并行（ADR-008）：每个已打开的智能体各挂载一个本组件实例（由 ChatPaneHost
 * 常驻渲染）；focused=false 的后台实例仅隐藏不卸载 —— 流式继续、互不打断，
 * 流结束且非焦点时回调 onStreamSettled 给侧栏记未读。techStack 为实例级状态，
 * 各智能体独立记忆，不再全局重置。
 *
 * @param {Object} props
 * @param {Object} props.agent                当前智能体
 * @param {boolean} [props.focused]           是否为当前可见窗格（URL 指向）
 * @param {(agentId:string, busy:boolean)=>void} [props.onBusyChange] 上报忙状态（流式/加载历史）
 * @param {(agentId:string)=>void} [props.onStreamSettled]    非焦点流结束时回调（记未读）
 */
export function ChatPage({
  agent,
  focused = true,
  onBusyChange,
  onStreamSettled,
}) {
  const agentName = agent?.id ?? ''

  // 实例级技术栈（并行窗格各自独立）
  const [techStack, setTechStack] = React.useState([])

  // 1) 会话列表（提供 currentSessionId 给 useAgentChat）
  const list = useSessionList(agentName)

  // 2) 流式聊天（currentSessionId 变化会重建 chatId 状态；响应头回传走 list.handleSessionIdFromHeader）
  const {
    messages,
    input,
    handleInputChange,
    handleSubmit,
    isLoading,
    error,
    stop,
    setMessages,
    setInput,
    append,
    stableChatId,
    stableChatIdRef,
    pauseAnnotationsClear,
    resumeAnnotationsClear,
  } = useAgentChat({
    agent,
    techStack,
    sessionId: list.currentSessionId,
    onSessionId: list.handleSessionIdFromHeader,
  })

  // 3) 切换会话 → 拉历史消息（消费 useAgentChat 的 setMessages / stableChatIdRef）
  const { loadingHistory } = useChatHistory({
    agentName,
    currentSessionId: list.currentSessionId,
    setMessages,
    stableChatIdRef,
  })

  // 首轮流式结束后，切到 header 回传的新建会话
  React.useEffect(() => {
    list.flushPendingSessionSwitch(isLoading)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading])

  // 加载历史期间暂停注解清理，避免刚 restore 的注解被 messages=[] 误清
  React.useEffect(() => {
    if (loadingHistory) pauseAnnotationsClear?.()
    else resumeAnnotationsClear?.()
  }, [loadingHistory, pauseAnnotationsClear, resumeAnnotationsClear])

  // 上报忙状态到注册表（流式 + 加载历史任一 true 都算忙）；
  // Header 只读「焦点窗格」的 busy，后台窗格的 busy 在侧栏显示脉点。
  React.useEffect(() => {
    onBusyChange?.(agentName, isLoading || loadingHistory)
  }, [agentName, isLoading, loadingHistory, onBusyChange])

  // 后台窗格一轮流式结束 → 记未读（焦点窗格不记，用户正看着）
  const prevLoadingRef = React.useRef(false)
  React.useEffect(() => {
    const was = prevLoadingRef.current
    prevLoadingRef.current = isLoading
    if (was && !isLoading && !focused) onStreamSettled?.(agentName)
  }, [isLoading, focused, agentName, onStreamSettled])

  const structured = !!agent?.structuredInput
  const isDocProcessor = agent?.id === 'doc-processor'
  const isResume = agent?.id === 'resume-analysis'
  const isInterview = agent?.id === 'mock-interview'

  // 简历分析：解析出的简历正文（由 ChatInput 上传回调写入，提交时经 body.resumeText 下发）
  const [resumeText, setResumeText] = React.useState('')
  React.useEffect(() => {
    setResumeText('')
  }, [agentName])
  const handleResumeParsed = React.useCallback((payload) => {
    setResumeText(payload?.text || '')
  }, [])

  // 模拟面试：结束并生成评分报告（发一条带 interviewFinish 的用户消息）
  const handleFinishInterview = React.useCallback(() => {
    if (isLoading) return
    append(
      { role: 'user', content: '结束本次面试，请给出评分报告。' },
      { body: { interviewFinish: true } },
    )
  }, [append, isLoading])

  // 4) 文档处理智能体：操作栏状态与 REST 编排
  const dp = useDocProcessor({ agentName, append, isLoading })

  // 切片预览面板的调整指令 → 作为用户消息发出（后端 adjust 分支处理）
  const handleChunkAdjust = React.useCallback(
    (instruction, docIdFromAnnotation) => {
      if (!instruction || isLoading) return
      const docId = docIdFromAnnotation || dp.activeDocId
      if (!docId) {
        log.warn('[ChatPage] 缺少 docId，跳过切片调整指令发送', { instruction })
        return
      }
      append({ role: 'user', content: instruction }, { body: { docId } })
    },
    [append, dp.activeDocId, isLoading],
  )

  return (
    <div className="flex h-full min-w-0 flex-1">
      {/* 左：会话列表 */}
      <SessionSidebar
        sessions={list.sessions}
        currentSessionId={list.currentSessionId}
        loading={list.sessionsLoading}
        onSelect={list.setCurrentSessionId}
        onCreate={list.createSession}
        onDelete={async (id) => {
          await list.deleteSession(id)
        }}
        onRename={list.renameSession}
      />

      {/* 右：对话区 */}
      <div className="relative flex h-full min-w-0 flex-1 flex-col">
        {loadingHistory && (
          <div className="pointer-events-none absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-full border bg-background/90 px-3 py-1 shadow backdrop-blur">
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              加载历史消息…
            </div>
          </div>
        )}

        <MessageList
          messages={messages}
          isLoading={isLoading}
          chatId={stableChatId}
          onAdjust={handleChunkAdjust}
        />
        {isDocProcessor && (
          <DocActionBar
            docs={dp.docs}
            activeDocId={dp.activeDocId}
            committed={dp.committed}
            busy={dp.committing}
            busyAll={dp.committingAll}
            commitError={dp.commitError}
            onSelectDoc={dp.handleSelectDoc}
            onPreview={dp.handlePreview}
            onCommit={dp.handleCommit}
            onCommitAll={dp.handleCommitAll}
            onExport={dp.handleExport}
          />
        )}
        {isInterview && !isLoading && (
          <div className="flex items-center justify-end gap-2 px-4 pb-1 md:px-6">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 gap-1.5"
              onClick={handleFinishInterview}
            >
              结束面试并生成评分报告
            </Button>
          </div>
        )}
        <ChatInput
          agent={agent}
          structured={structured}
          techStack={techStack}
          onTechStackChange={setTechStack}
          input={input}
          handleInputChange={handleInputChange}
          handleSubmit={handleSubmit}
          isLoading={isLoading}
          onStop={stop}
          error={error}
          isDocProcessor={isDocProcessor}
          activeDocId={dp.activeDocId}
          setInput={setInput}
          onDocUploaded={dp.handleDocUploaded}
          upload={isResume ? { endpoint: '/api/resume/parse', accept: '.pdf,.docx,.md,.markdown,.txt', hint: '请分析我的简历，并给出优化建议与可能的面试追问。' } : undefined}
          onResumeParsed={isResume ? handleResumeParsed : undefined}
          resumeText={isResume ? resumeText : undefined}
        />

        <DocPreviewDialog
          open={dp.showPreviewDialog}
          onOpenChange={dp.setShowPreviewDialog}
          docId={dp.activeDocId}
          title={dp.activeDoc?.title || ''}
          docs={dp.docs}
          onAdjusted={(instruction, r) =>
            dp.appendOpReport(instruction, {
              op: 'adjust',
              docId: dp.activeDocId,
              instruction,
              totalChunks: r.totalChunks,
              totalChars: r.totalChars,
            })
          }
        />
        <DocExportDialog
          open={dp.showExportDialog}
          onOpenChange={dp.setShowExportDialog}
          docId={dp.activeDocId}
          title={dp.activeDoc?.title || ''}
        />
      </div>
    </div>
  )
}

export default ChatPage
