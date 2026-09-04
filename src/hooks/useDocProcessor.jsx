import * as React from 'react'
import { commitDoc, commitDocs } from '@/lib/docProcessorApi'
import { child } from '@/lib/logger'

const log = child('chat:docprocessor')

/**
 * useDocProcessor —— 文档处理智能体的操作栏状态与 REST 编排
 *
 * 职责：
 *  - 已上传文档列表（多文件）与当前操作对象
 *  - 预览 / 导出对话框开关
 *  - 入库（单个 / 全部）与 opReport 回报
 *
 * @param {Object} opts
 * @param {string} opts.agentName            智能体 id（切换时重置状态）
 * @param {Function} opts.append             useChat 的 append（发送 opReport 用户消息）
 * @param {boolean} opts.isLoading           流式生成中（生成中禁止 append）
 */
export function useDocProcessor({ agentName, append, isLoading }) {
  // 已上传文档列表（多文件上传支持），activeDocId 为当前操作对象
  const [docs, setDocs] = React.useState([]) // [{ docId, title, committed }]
  const [activeDocId, setActiveDocId] = React.useState('')
  // 底部操作栏状态：预览/导出对话框开关、入库状态
  const [showPreviewDialog, setShowPreviewDialog] = React.useState(false)
  const [showExportDialog, setShowExportDialog] = React.useState(false)
  const [committing, setCommitting] = React.useState(false)
  const [committingAll, setCommittingAll] = React.useState(false)
  const [commitError, setCommitError] = React.useState('')
  // 预览回报去重：记录已回报过预览的 docId —— 「预览切片」每点一次都 append 一条
  // opReport 消息会刷屏，限制为每份文档只回报一次，后续点击仅打开预览界面。
  const previewReportedDocRef = React.useRef('')

  const activeDoc = docs.find((d) => d.docId === activeDocId)
  const committed = !!activeDoc?.committed

  // 切换智能体时重置文档上下文与操作栏状态
  React.useEffect(() => {
    setDocs([])
    setActiveDocId('')
    setCommitError('')
    setShowPreviewDialog(false)
    setShowExportDialog(false)
  }, [agentName])

  const handleDocUploaded = React.useCallback((docId, title) => {
    // 多文件上传：追加到文档列表，新上传的自动成为当前操作对象
    setDocs((prev) => [
      ...prev,
      { docId, title: title || '', committed: false },
    ])
    setActiveDocId(docId)
    setCommitError('')
    // 预览回报去重：新文档允许再回报一次预览
    previewReportedDocRef.current = ''
  }, [])

  /** 操作栏文档切换 */
  const handleSelectDoc = React.useCallback((docId) => {
    setActiveDocId(docId)
    setCommitError('')
  }, [])

  /**
   * 操作栏回报：REST 操作完成后 append 一条带 body.opReport 的用户消息
   * → 后端拦截生成「卡片注解 + LLM 简要总结文本」（不走 ReAct，不重复执行工具）。
   */
  const appendOpReport = React.useCallback(
    (content, opReport) => {
      if (!activeDocId || isLoading) return
      append(
        { role: 'user', content },
        { body: { docId: activeDocId, opReport } },
      )
    },
    [append, activeDocId, isLoading],
  )

  /** 操作栏「入库」：直调 REST（按钮点击即用户明确确认），完成后标记已入库 */
  const handleCommit = React.useCallback(async () => {
    if (!activeDocId || committing || committed) return
    setCommitting(true)
    setCommitError('')
    try {
      const r = await commitDoc(activeDocId)
      setDocs((prev) =>
        prev.map((d) =>
          d.docId === activeDocId ? { ...d, committed: true } : d,
        ),
      )
      appendOpReport('入库', {
        op: 'commit',
        docId: activeDocId,
        chunkCount: r.chunkCount,
        totalChars: r.totalChars,
        ms: r.ms,
        skippedWithin: r.skippedWithin,
        skippedCross: r.skippedCross,
      })
    } catch (err) {
      // 409 = 已入库过：视为成功，标记已入库并给出提示
      if (err.status === 409) {
        setDocs((prev) =>
          prev.map((d) =>
            d.docId === activeDocId ? { ...d, committed: true } : d,
          ),
        )
        setCommitError(err.message || '该文档已入库')
      } else {
        setCommitError(err.message || '入库失败')
      }
    } finally {
      setCommitting(false)
    }
  }, [activeDocId, committing, committed, appendOpReport])

  /** 操作栏「全部入库」：批量入库所有未入库文档（单个失败不中断整批） */
  const handleCommitAll = React.useCallback(async () => {
    const pending = docs.filter((d) => !d.committed).map((d) => d.docId)
    if (pending.length < 2 || committing || committingAll) return
    setCommittingAll(true)
    setCommitError('')
    try {
      const r = await commitDocs(pending)
      const okIds = new Set(r.results.filter((x) => x.ok).map((x) => x.docId))
      setDocs((prev) =>
        prev.map((d) => (okIds.has(d.docId) ? { ...d, committed: true } : d)),
      )
      appendOpReport('批量入库', {
        op: 'commit-batch',
        docId: activeDocId,
        okCount: r.okCount,
        failCount: r.failCount,
        results: r.results.map((x) => ({
          docId: x.docId,
          ok: x.ok,
          chunkCount: x.chunkCount,
          error: x.error,
        })),
      })
      if (r.failCount > 0) {
        setCommitError(`${r.failCount} 个文档入库失败（已入库的自动跳过）`)
      }
    } catch (err) {
      setCommitError(err.message || '批量入库失败')
    } finally {
      setCommittingAll(false)
    }
  }, [docs, committing, committingAll, activeDocId, appendOpReport])

  /** 预览按钮：打开对话框 + 每份文档只回报一次 */
  const handlePreview = React.useCallback(() => {
    setShowPreviewDialog(true)
    if (previewReportedDocRef.current !== activeDocId) {
      previewReportedDocRef.current = activeDocId
      appendOpReport('预览切片', { op: 'preview', docId: activeDocId })
    }
  }, [activeDocId, appendOpReport])

  /** 导出按钮：打开对话框 + 回报 */
  const handleExport = React.useCallback(() => {
    setShowExportDialog(true)
    appendOpReport('导出', { op: 'export', docId: activeDocId })
  }, [activeDocId, appendOpReport])

  return {
    docs,
    activeDocId,
    activeDoc,
    committed,
    committing,
    committingAll,
    commitError,
    showPreviewDialog,
    setShowPreviewDialog,
    showExportDialog,
    setShowExportDialog,
    handleDocUploaded,
    handleSelectDoc,
    handleCommit,
    handleCommitAll,
    handlePreview,
    handleExport,
    appendOpReport,
  }
}

/** 调试用：静默记录（保留与旧版一致的行为） */
export function _logChunkAdjustSkip(instruction) {
  log.warn('[useDocProcessor] 缺少 docId，跳过切片调整指令发送', {
    instruction,
  })
}
