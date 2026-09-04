/**
 * chunkPresets —— 文档上传切片预设与常量
 *
 * 从 DocumentUploader.jsx 提取的纯常量 / 辅助函数，无 React 依赖，便于复用与测试。
 */

// 目标字数合法范围，与后端硬校验一致
export const MAX_CHARS_MIN = 50
export const MAX_CHARS_MAX = 5000
// 相邻块重叠字符数范围（最小 0 = 不重叠）
export const OVERLAP_MIN = 0
export const OVERLAP_MAX = 500

// 并发上传的 worker 数（embedding 在服务端，2 并发对本地 Ollama 足够友好）
export const UPLOAD_CONCURRENCY = 2

// job stage → 中文进度文案
export const STAGE_LABELS = {
  chunking: '切片中…',
  embedding: '向量嵌入中…',
  indexing: '写入索引…',
  done: '完成',
  error: '失败',
}

/**
 * 预设切片策略（chunker 的 splitByDelimiter 按字面字符串 split，换行/标题符可直接用）
 * - key: 预设标识；delimiter: 真实分隔符（null = semantic 语义感知）
 * - maxChars: 超长块的兜底再切阈值（段落合并 → 句子硬切，保证不腰斩）
 */
export const CHUNK_PRESETS = [
  {
    key: 'semantic',
    label: '语义感知（推荐）',
    hint: '标题→段落→句子三层递归 + 超长块语义细切，通用于 Markdown / 结构化文档',
    delimiter: null,
    maxChars: null,
  },
  {
    key: 'para',
    label: '双换行分段',
    hint: '按空行（段落）切分，块粒度均匀；适合普通散文、笔记',
    delimiter: '\n\n',
    maxChars: 800,
  },
  {
    key: 'line',
    label: '逐行切分',
    hint: '每一行一个切片；适合清单、日志、一行一条的语料',
    delimiter: '\n',
    maxChars: 400,
  },
  {
    key: 'hr',
    label: '--- 分隔线',
    hint: '按 Markdown 水平线切分；适合用 --- 手工分节的文档',
    delimiter: '---',
    maxChars: 1000,
  },
  {
    key: 'h2',
    label: '## 二级标题',
    hint: '按二级标题切章节；适合多小节的长文档（三级及以下归入所属二级标题）',
    delimiter: '##',
    maxChars: 1500,
  },
  {
    key: 'h1',
    label: '# 一级标题',
    hint: '按一级标题切大章；块更大、上下文更完整，适合章节数少的材料',
    delimiter: '#',
    maxChars: 2000,
  },
  {
    key: 'custom',
    label: '自定义',
    hint: '手动填写分隔符与目标字数',
    delimiter: undefined,
    maxChars: 1000,
  },
]

/**
 * 文件条目状态 → 右侧状态文案
 * @param {{ status: string, chunkCount?: number, stage?: string }} f
 */
export function entryStatusText(f) {
  switch (f.status) {
    case 'preparing':
      return '解析切片中…'
    case 'ready':
      return f.chunkCount != null ? `就绪 · ${f.chunkCount} 块` : '就绪'
    case 'committing':
      return f.stage || '排队中…'
    default:
      return ''
  }
}
