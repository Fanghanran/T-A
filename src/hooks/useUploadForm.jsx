import * as React from 'react'
import { prepareDocument, commitDocument, getUploadJob } from '@/lib/knowledgeApi'
import { listTemplates } from '@/lib/docProcessorApi'
import { MAX_CHARS_MIN, MAX_CHARS_MAX, OVERLAP_MIN, OVERLAP_MAX, UPLOAD_CONCURRENCY, STAGE_LABELS } from '@/lib/chunkPresets'

/**
 * useUploadForm —— 上传文档对话框的全部状态与两段式上传编排（纯逻辑不含 UI；UI 见 DocumentUploader / ChunkStrategyForm / UploadFileList）。
 * 两段式上传（①）：① prepare 服务端抽文本+切片+评分（秒级，PDF/DOCX 也可预览），正文缓存在服务端；
 * ② commit 确认后才 embedding+入库，异步 job 轮询进度（④）；③ 并发（2 worker）处理多文件（prepare 在各 worker 内按需触发）。
 * @param {()=>void} [opts.onUploaded] 全部（或部分）上传完成回调（父级刷新列表）；uploading 外部上传状态（仅用于禁用提交/触发按钮）
 */
export function useUploadForm({ onUploaded, uploading } = {}) {
  // —— 弹窗 + 多文件条目：{ file, status: pending|preparing|ready|committing|ok|fail, previewId?, chunks?, chunkCount?, avgScore?, stage?, error?, strategyKey? } ——
  const [open, setOpen] = React.useState(false)
  const [files, setFiles] = React.useState([])
  const [batchProgress, setBatchProgress] = React.useState(null) // { done, total }
  const [presetKey, setPresetKey] = React.useState('semantic') // 预设策略标识（CHUNK_PRESETS 的 key）；delimiter/maxChars 选预设时自动填充，custom 时手填
  const [chunkStrategy, setChunkStrategy] = React.useState('semantic')
  const [delimiter, setDelimiter] = React.useState('')
  const [maxChars, setMaxChars] = React.useState(1000)
  const [overlapChars, setOverlapChars] = React.useState(0) // 相邻块滑动窗口重叠字符数（仅 delimiter 策略生效；0 = 不重叠）
  const [category, setCategory] = React.useState('')
  const [tags, setTags] = React.useState([])
  const [tagInput, setTagInput] = React.useState('')
  const [withQuestions, setWithQuestions] = React.useState(false) // ⑤ 检索增强问题按需生成（默认关：普通资料库不需要，省一次 LLM 调用）
  const [templates, setTemplates] = React.useState([]) // 处理模板（文档处理智能体保存的常用切片参数组合）
  const [templatesError, setTemplatesError] = React.useState('')
  const [previewOpen, setPreviewOpen] = React.useState(false) // 预览弹窗状态
  const [previewData, setPreviewData] = React.useState(null)
  const filesRef = React.useRef(files) // workers 里读最新 files（避免闭包拿到旧数组）
  filesRef.current = files
  // 当前切片策略指纹：参数变了，已 prepare 的预览全部失效（分隔符不 trim，保留 \n 类空白符）
  const strategyKey = `${chunkStrategy}|${delimiter}|${maxChars}|${overlapChars}`

  React.useEffect(() => {
    if (!open) return
    let alive = true
    setTemplatesError('')
    listTemplates().then((list) => { if (alive) setTemplates(Array.isArray(list) ? list : []) }).catch((e) => { if (alive) setTemplatesError(e?.message || '模板加载失败') })
    return () => { alive = false }
  }, [open])

  // 重置全部表单状态（关闭弹窗 / 全部上传成功时调用）
  const reset = React.useCallback(() => {
    const initial = [
      [setFiles, []], [setBatchProgress, null], [setPresetKey, 'semantic'], [setChunkStrategy, 'semantic'],
      [setDelimiter, ''], [setMaxChars, 1000], [setOverlapChars, 0], [setCategory, ''], [setTags, []],
      [setTagInput, ''], [setWithQuestions, false], [setPreviewData, null],
    ]
    initial.forEach(([set, v]) => set(v))
  }, [])
  /** 选中预设策略：自动填充分隔符与目标字数；选自定义进入手填模式 */
  const selectPreset = (p) => {
    if (!p) return
    setPresetKey(p.key)
    if (p.delimiter === null) {
      setChunkStrategy('semantic')
      setDelimiter('')
      return
    }
    setChunkStrategy('delimiter')
    if (p.key === 'custom') return // 手填模式不动现有值
    setDelimiter(p.delimiter)
    if (Number.isFinite(p.maxChars)) setMaxChars(p.maxChars)
  }
  const addTag = (v) => {
    const t = v.trim()
    if (!t || tags.includes(t)) return
    setTags((prev) => [...prev, t])
    setTagInput('')
  }
  /** 按索引更新条目（不可变更新，触发重渲染） */
  const updateEntry = (idx, patch) => setFiles((prev) => prev.map((f, i) => (i === idx ? { ...f, ...patch } : f)))
  const handleFiles = (e) => {
    const list = Array.from(e.target.files ?? [])
    if (list.length) setFiles((prev) => [...prev, ...list.map((file) => ({ file, status: 'pending' }))])
    e.target.value = ''
  }
  const removeFileAt = (i) => setFiles((prev) => prev.filter((_, idx) => idx !== i))
  /** 套用模板：把模板参数填入表单（模板是自由参数组合，预设标识切到对应模式） */
  const applyTemplate = (t) => {
    if (!t) return
    const strategy = t.strategy === 'delimiter' ? 'delimiter' : 'semantic'
    setChunkStrategy(strategy)
    setPresetKey(strategy === 'delimiter' ? 'custom' : 'semantic')
    setDelimiter(strategy === 'delimiter' && typeof t.delimiter === 'string' ? t.delimiter : '')
    if (Number.isFinite(Number(t.maxChars))) setMaxChars(Number(t.maxChars))
  }
  // delimiter 模式下分隔符必填（不能 trim：预设本身可能就是 \n / \n\n 这类空白分隔符）；maxChars 范围校验（HTML min/max 拦不住手输）
  const delimiterValid = chunkStrategy !== 'delimiter' || delimiter.length > 0
  const maxCharsValue = Number(maxChars)
  const maxCharsError =
    chunkStrategy !== 'delimiter' ? ''
      : !Number.isInteger(maxCharsValue) ? '请填写有效的目标字数'
        : maxCharsValue < MAX_CHARS_MIN || maxCharsValue > MAX_CHARS_MAX ? `目标字数需在 ${MAX_CHARS_MIN} ~ ${MAX_CHARS_MAX} 之间` : ''
  // 相邻块重叠字符数校验（最小 0 = 不重叠）
  const overlapValue = Number(overlapChars)
  const overlapError =
    chunkStrategy !== 'delimiter' ? ''
      : !Number.isInteger(overlapValue) || overlapValue < OVERLAP_MIN || overlapValue > OVERLAP_MAX ? `重叠字符数需在 ${OVERLAP_MIN} ~ ${OVERLAP_MAX} 之间的整数（0 = 不重叠）` : ''
  const formError = !delimiterValid ? '请填写分隔符' : maxCharsError || overlapError
  /** ① prepare 单个文件（服务端抽文本+切片+评分；重复内容会抛 409 AppError） */
  const prepareOne = async (idx) => {
    const entry = filesRef.current[idx]
    if (!entry) return null
    if (entry.previewId && entry.strategyKey === strategyKey) return entry
    updateEntry(idx, { status: 'preparing', error: null })
    try {
      // 非 delimiter 策略不传切片参数；delimiter 原样传，\n 类空白分隔符不能 trim
      const meta = chunkStrategy !== 'delimiter' ? {} : { chunkStrategy: 'delimiter', delimiter, maxChars, overlapChars }
      const r = await prepareDocument(entry.file, meta)
      const next = { status: 'ready', previewId: r.previewId, chunks: r.chunks, chunkCount: r.chunkCount, avgScore: r.avgScore, strategyKey, error: null }
      updateEntry(idx, next)
      return { ...entry, ...next }
    } catch (e) {
      updateEntry(idx, { status: 'fail', error: e?.message || '解析失败' })
      return null
    }
  }
  /** ④ commit 单个文件：异步 job + 轮询进度，实时更新条目 stage */
  const commitOne = async (idx) => {
    let entry = filesRef.current[idx]
    if (!entry) return false
    if (!entry.previewId || entry.strategyKey !== strategyKey) entry = await prepareOne(idx)
    if (!entry) return false
    updateEntry(idx, { status: 'committing', stage: '入库中…' })
    try {
      const { jobId } = await commitDocument(entry.previewId, { category, tags, withQuestions, async: true })
      for (;;) {
        await new Promise((r) => setTimeout(r, 600))
        const job = await getUploadJob(jobId).catch((e) => { throw new Error(e?.message || '进度查询失败') })
        updateEntry(idx, { stage: STAGE_LABELS[job.stage] ?? job.stage, chunkCount: job.chunkCount ?? entry.chunkCount })
        if (job.stage === 'done') {
          updateEntry(idx, { status: 'ok', stage: null })
          return true
        }
        if (job.stage === 'error') throw new Error(job.error || '入库失败')
      }
    } catch (e) {
      updateEntry(idx, { status: 'fail', stage: null, error: e?.message || '入库失败' })
      return false
    }
  }
  /** ③ 并发上传：UPLOAD_CONCURRENCY 个 worker 消费待传条目 */
  const handleSubmit = async (e) => {
    e.preventDefault()
    if (files.length === 0 || uploading || formError || batchProgress) return
    const idxs = filesRef.current.map((f, i) => ((f.status === 'pending' || f.status === 'ready') && !f.error ? i : -1)).filter((i) => i >= 0)
    if (idxs.length === 0) return
    setBatchProgress({ done: 0, total: idxs.length })
    let done = 0, okCount = 0, cursor = 0
    const worker = async () => {
      for (;;) {
        const i = idxs[cursor++]
        if (i == null) return
        const ok = await commitOne(i)
        done++
        if (ok) okCount++
        setBatchProgress({ done, total: idxs.length })
      }
    }
    await Promise.all(Array.from({ length: UPLOAD_CONCURRENCY }, worker))
    onUploaded?.()
    setBatchProgress(null)
    // 全部成功 → 关闭弹窗；有失败 → 保留失败项供移除/重试
    if (okCount === idxs.length) {
      reset()
      setOpen(false)
    }
  }
  /** ① 预览：prepare 第一个未完成文件（服务端解析，PDF/DOCX 也可预览）后弹窗展示 */
  const handlePreview = async (e) => {
    e?.preventDefault?.()
    if (files.length === 0 || formError || batchProgress) return
    const idx = files.findIndex((f) => f.status !== 'ok')
    if (idx < 0) return
    setPreviewData({ loading: true, chunks: [], total: 0, error: null })
    setPreviewOpen(true)
    let entry = filesRef.current[idx]
    if (!entry.previewId || entry.strategyKey !== strategyKey) entry = await prepareOne(idx)
    if (!entry) return setPreviewData({ loading: false, chunks: [], total: 0, error: filesRef.current[idx]?.error || '解析失败' })
    setPreviewData({ loading: false, chunks: entry.chunks ?? [], total: entry.chunkCount ?? 0, avgScore: entry.avgScore, error: null })
  }
  const uploadableCount = files.filter((f) => (f.status === 'pending' || f.status === 'ready') && !f.error).length

  return {
    // 弹窗 / 文件 / 进度
    open, setOpen, reset, files, handleFiles, removeFileAt, uploadableCount, batchProgress,
    // 策略与校验
    presetKey, chunkStrategy, delimiter, setDelimiter, maxChars, setMaxChars, overlapChars, setOverlapChars,
    strategyKey, selectPreset, applyTemplate, maxCharsError, overlapError, formError,
    // 元数据 / 模板 / 动作 / 预览弹窗
    category, setCategory, tags, setTags, tagInput, setTagInput, addTag, withQuestions, setWithQuestions,
    templates, templatesError, handleSubmit, handlePreview, previewOpen, setPreviewOpen, previewData,
  }
}
