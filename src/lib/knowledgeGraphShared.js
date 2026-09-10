/**
 * knowledgeGraphShared —— 知识网络图共享逻辑（纯函数，无 React）
 *
 * 从 KnowledgeGraphCard 抽取的公共部分，供仪表盘卡片（KnowledgeGraphCard）
 * 与独立页面（KnowledgeGraphPage）复用，保证两处视图派生口径完全一致：
 *  - 派生视图 deriveGraphView：阈值过滤边 → 重算度数 → 关键词匹配集
 *  - 大图分组预布局 computeGroupedLayout（2D 大图模式）
 *  - 转义 / 截断等 tooltip 工具
 *
 * 节点类型口径：chunk（知识切片，按文档着色）/ wiki（LLM 词条节点，
 * 服务器端生成合并，琥珀色 + 菱形/八面体区分）。
 */

/** 服务端裁边下限（拉全量边，前端滑杆在此之上本地过滤） */
export const FETCH_THRESHOLD = 0.5
/** 前端阈值滑杆范围（上限与后端参数校验一致） */
export const SLIDER_MIN = 0.5
export const SLIDER_MAX = 0.95
/** 默认阈值：密度与可读性的平衡点（当前库 0.7 ≈ 290 边） */
export const DEFAULT_THRESHOLD = 0.7
/**
 * 力导向布局节点上限：超过即切换大图模式（预计算分组布局 + large
 * 渲染管线 + progressive 渐进渲染）。Canvas force 布局逐帧迭代模拟，
 * 2000 节点后帧率明显下滑，万级不可用；大图模式首帧毫秒级出图。
 */
export const FORCE_LIMIT = 2000

/** LLM Wiki 词条节点专属色（琥珀，与文档调色板区分） */
export const WIKI_COLOR = '#f59e0b'

/**
 * ECharts v5 默认调色板（graph 按类别取色）。2D 视图显式声明
 * 该调色板并在末尾追加词条色，使「Wiki 词条」图例色与节点色一致。
 */
export const ECHARTS_PALETTE = [
  '#5470c6',
  '#91cc75',
  '#fac858',
  '#ee6666',
  '#73c0de',
  '#3ba272',
  '#fc8452',
  '#9a60b4',
  '#ea7ccc',
]

/**
 * 大图模式预计算分组布局：文档簇沿外环均匀分布，簇内节点绕簇心
 * 环形排列。O(n) 毫秒级完成，替代 force 迭代；同文档自然聚簇，
 * 跨簇边可读（跨文档语义关联仍然可见）。
 * wiki 词条节点 docId 为空串，自然形成独立簇（词条环带）。
 * @param {Array} nodes 视图节点（含 docId）
 * @returns {Array<{x:number,y:number}>} 与节点同序的坐标
 */
export function computeGroupedLayout(nodes) {
  const groups = new Map()
  nodes.forEach((n, i) => {
    const g = groups.get(n.docId)
    if (g) g.push(i)
    else groups.set(n.docId, [i])
  })
  const G = groups.size
  // 簇内半径按簇规模开方（密度均匀）；外环半径保证簇间不相交
  let maxR2 = 14
  for (const idxs of groups.values()) {
    maxR2 = Math.max(maxR2, 9 * Math.sqrt(idxs.length))
  }
  const R1 = Math.max(200, (maxR2 * G) / (2 * Math.PI) + maxR2 + 40)
  const pos = new Array(nodes.length)
  let gi = 0
  for (const idxs of groups.values()) {
    const cx = R1 * Math.cos((2 * Math.PI * gi) / G)
    const cy = R1 * Math.sin((2 * Math.PI * gi) / G)
    const r2 = Math.max(14, 9 * Math.sqrt(idxs.length))
    idxs.forEach((i, k) => {
      const a = (2 * Math.PI * k) / idxs.length
      pos[i] = { x: cx + r2 * Math.cos(a), y: cy + r2 * Math.sin(a) }
    })
    gi++
  }
  return pos
}

/** tooltip 内文本转义（snippet/heading 含原文，防止注入 HTML） */
export function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/** 截断长文本（图例 / 强调标签用） */
export function truncate(s, n = 14) {
  return s.length > n ? `${s.slice(0, n)}…` : s
}

/**
 * 派生视图：按滑杆阈值过滤边 → 重算度数 → 关键词匹配集。
 * 无关键词时淡化孤立节点（过滤后度数为 0），有关键词时淡化未命中节点。
 *
 * 与原卡片内联实现完全同口径（不传 selectedDocIds / includeWikiNodes
 * 时行为即原行为）；独立页面额外支持：
 *  - selectedDocIds：文档筛选（null = 全部；wiki 节点不受文档筛选直接保留，
 *    依赖边过滤自然裁剪无连接的词条）
 *  - includeWikiNodes：是否显示 wiki 词条节点
 *
 * @param {Object} data GET /api/management/vector/graph 响应
 * @param {Object} [opts]
 * @param {number} opts.threshold 相似度阈值（本地过滤）
 * @param {string} opts.keyword 检索关键词
 * @param {Set<string>|null} [opts.selectedDocIds] 选中文档集合
 * @param {boolean} [opts.includeWikiNodes] 是否包含 wiki 节点
 * @returns {{nodes:Array,edges:Array,degree:Map,matched:Set,kw:string,nodeById:Map}|null}
 */
export function deriveGraphView(
  data,
  { threshold, keyword, selectedDocIds = null, includeWikiNodes = true },
) {
  if (!data) return null
  const kw = keyword.trim().toLowerCase()
  let nodes = data.nodes ?? []
  if (selectedDocIds) {
    nodes = nodes.filter((n) =>
      n.type === 'wiki'
        ? includeWikiNodes
        : selectedDocIds.has(n.docId),
    )
  } else if (!includeWikiNodes) {
    nodes = nodes.filter((n) => n.type !== 'wiki')
  }
  const nodeIdSet = new Set(nodes.map((n) => n.id))
  // 阈值过滤 + 端点必须在过滤后节点集内（文档筛选会移除部分节点）
  const edges = (data.edges ?? []).filter(
    (e) =>
      e.similarity >= threshold &&
      nodeIdSet.has(e.source) &&
      nodeIdSet.has(e.target),
  )
  const degree = new Map()
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1)
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1)
  }
  const matched = new Set()
  if (kw) {
    for (const n of nodes) {
      if (
        (n.heading || '').toLowerCase().includes(kw) ||
        (n.topic || '').toLowerCase().includes(kw) ||
        (n.name || '').toLowerCase().includes(kw) ||
        (n.snippet || '').toLowerCase().includes(kw) ||
        (n.docTitle || '').toLowerCase().includes(kw)
      ) {
        matched.add(n.id)
      }
    }
  }
  const nodeById = new Map(nodes.map((n) => [n.id, n]))
  return { nodes, edges, degree, matched, kw, nodeById }
}
