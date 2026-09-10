import * as React from 'react'
import * as THREE from 'three'
import ForceGraph3D from 'react-force-graph-3d'
import { WIKI_COLOR } from '@/lib/knowledgeGraphShared'

/**
 * KnowledgeGraph3D —— 知识库网络图 3D 视图（懒加载）
 *
 * Three.js 力导向 3D 布局（react-force-graph-3d）：
 *  - 节点 = 知识切片球体（按文档着色，大小 = 关联度数）；
 *    wiki 词条节点 = 琥珀色球体 + 八面体线框光晕（与切片明显区分）
 *  - 边 = text_vector 余弦相似度（粗细 = 超出阈值的强度，强边带流动粒子）；
 *    词条提及边（kind='mention'）同样渲染
 *  - 交互：拖拽旋转 / 滚轮缩放 / 节点拖拽（松手固定不弹回）/ 悬停详情 / 点击回调
 *
 * 节点尺寸说明：库内球体半径 = cbrt(val) * nodeRelSize，拖拽的射线
 * 检测直接打在球体网格上；相机距离约 cbrt(N)*170 ≈ 千级单位，节点
 * 半径必须给到 8+ 单位（屏幕 6px+）才能被指针稳定抓取，否则拖拽
 * 落空退化为旋转视角。
 *
 * 与 2D 视图共享父组件派生的 view（阈值过滤后的边、度数、关键词匹配集），
 * 关键词模式下淡化未命中节点与跨命中边（灰色 + 缩小），与 2D 淡化口径一致。
 *
 * @param {Object} props
 * @param {Object} props.view 父组件派生视图（nodes/edges/degree/matched/kw）
 * @param {Array} props.docs 文档列表（id 映射调色板索引）
 * @param {number} props.threshold 当前相似度阈值（边粗细基准）
 * @param {number} [props.focusSignal] Enter 定位信号（递增触发相机聚焦首个匹配）
 * @param {(node:Object)=>void} [props.onNodeClick] 节点点击回调（切片跳转 / wiki 开面板）
 */

/** 文档调色板（一个文档一个颜色，与 2D 类别着色语义一致） */
const DOC_PALETTE = [
  '#38bdf8',
  '#a78bfa',
  '#34d399',
  '#fbbf24',
  '#f472b6',
  '#22d3ee',
  '#fb923c',
  '#a3e635',
  '#e879f9',
  '#f87171',
  '#4ade80',
  '#facc15',
]
/** 淡化色（关键词未命中 / 孤立节点） */
const DIM_COLOR = '#64748b'
/** 常规边色 */
const LINK_COLOR = '#94a3b8'
/** 淡化边色（关键词模式下跨命中边） */
const LINK_DIM_COLOR = '#475569'

/**
 * wiki 词条节点的八面体光晕：几何体与材质模块级共享（每节点各建
 * Mesh 实例，three 对象不可多父共享），线框琥珀色包在球体外侧，
 * 形成「知识枢纽」的视觉标识。
 */
const wikiHaloGeo = new THREE.OctahedronGeometry(1)
const wikiHaloMat = new THREE.MeshBasicMaterial({
  color: WIKI_COLOR,
  wireframe: true,
  transparent: true,
  opacity: 0.8,
})

/** tooltip 内文本转义（snippet/heading 含原文，防止注入 HTML） */
function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

export default function KnowledgeGraph3D({
  view,
  docs,
  threshold,
  focusSignal = 0,
  onNodeClick,
}) {
  const fgRef = React.useRef(null)
  const wrapRef = React.useRef(null)
  const [size, setSize] = React.useState({ w: 0, h: 0 })

  // 最新 view/graphData 挂 ref：focusSignal effect 只随信号触发，不随数据变化重聚焦
  const viewRef = React.useRef(null)
  viewRef.current = view
  const graphDataRef = React.useRef(null)

  /** 容器尺寸自适应（ResizeObserver → 显式 width/height 传入画布） */
  React.useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /**
   * 图数据：view → 力导向 nodes/links。
   * 映射为全新对象（库会在节点上原地写入 x/y/z 等模拟字段，
   * 不能直接复用父级 view.nodes 引用，避免污染）。
   */
  const graphData = React.useMemo(() => {
    if (!view) return null
    const docIndex = new Map((docs ?? []).map((d, i) => [d.id, i]))
    const isDim = (n) => {
      if (view.kw) return !view.matched.has(n.id)
      return (view.degree.get(n.id) ?? 0) === 0
    }
    const nodes = view.nodes.map((n) => {
      const dim = isDim(n)
      const deg = view.degree.get(n.id) ?? 0
      const isWiki = n.type === 'wiki'
      return {
        id: n.id,
        raw: n,
        type: n.type ?? 'chunk',
        name: isWiki
          ? n.name || n.heading || n.id
          : n.heading || n.topic || `切片 ${n.idx}`,
        docTitle: n.docTitle,
        snippet: n.snippet,
        summary: n.summary,
        degree: deg,
        color: isWiki
          ? dim
            ? DIM_COLOR
            : WIKI_COLOR
          : dim
            ? DIM_COLOR
            : DOC_PALETTE[docIndex.get(n.docId) % DOC_PALETTE.length] ??
              DOC_PALETTE[0],
        // 球体半径 = cbrt(val) * nodeRelSize（4~28 → 半径 8~15）：
        // 保证最小球也可被指针稳定抓取（拖拽 raycast 打在球体网格上）
        // wiki 词条节点按提及数加大（知识枢纽视觉权重更高）
        val: dim
          ? 1.5
          : isWiki
            ? 8 + Math.min(20, deg * 1.5)
            : 4 + Math.min(24, deg * 1.6),
      }
    })
    const links = view.edges.map((e) => ({
      source: e.source,
      target: e.target,
      sim: e.similarity,
      kind: e.kind,
      // 关键词模式下仅两端均命中的边保持亮色，其余淡化
      dim: !!view.kw && !(view.matched.has(e.source) && view.matched.has(e.target)),
    }))
    return { nodes, links }
  }, [view, docs])

  graphDataRef.current = graphData

  /** Enter 定位：相机平滑聚焦首个匹配节点（信号驱动，避免随数据变化误触发） */
  React.useEffect(() => {
    if (!focusSignal || !fgRef.current) return
    const v = viewRef.current
    if (!v?.kw || v.matched.size === 0) return
    const first = v.nodes.find((n) => v.matched.has(n.id))
    if (!first) return
    const gn = graphDataRef.current?.nodes.find((m) => m.id === first.id)
    if (!gn || gn.x == null) return
    fgRef.current.cameraPosition(
      { x: gn.x, y: gn.y, z: gn.z + 150 },
      { x: gn.x, y: gn.y, z: gn.z },
      800,
    )
  }, [focusSignal])

  /** 悬停详情（HTML 字符串，库渲染为 tooltip；wiki 词条单独口径） */
  const nodeLabel = React.useCallback((n) => {
    if (n.type === 'wiki') {
      const text = String(n.summary ?? n.snippet ?? '')
      const clipped = text.length > 160 ? `${text.slice(0, 160)}…` : text
      return `<div style="max-width:260px">
        <div style="font-weight:600;margin-bottom:2px">${esc(n.name)}</div>
        <div style="opacity:0.75;font-size:11px">${esc(n.raw?.topic || '词条')} · 提及 ${n.degree} 处</div>
        ${clipped ? `<div style="margin-top:4px;font-size:11px;line-height:1.5">${esc(clipped)}</div>` : ''}
      </div>`
    }
    const text = String(n.snippet ?? '')
    const snippet = text.length > 120 ? `${text.slice(0, 120)}…` : text
    return `<div style="max-width:260px">
      <div style="font-weight:600;margin-bottom:2px">${esc(n.name)}</div>
      <div style="opacity:0.75;font-size:11px">${esc(n.docTitle)} · 关联 ${n.degree}</div>
      ${snippet ? `<div style="margin-top:4px;font-size:11px;line-height:1.5">${esc(snippet)}</div>` : ''}
    </div>`
  }, [])

  return (
    <div ref={wrapRef} className="h-full w-full">
      {size.w > 0 && graphData && (
        <ForceGraph3D
          ref={fgRef}
          width={size.w}
          height={size.h}
          graphData={graphData}
          /* 透明背景：与卡片画布容器底色融合（浅色/深色主题均可） */
          backgroundColor="rgba(0,0,0,0)"
          nodeRelSize={5}
          nodeResolution={12}
          nodeVal="val"
          nodeColor="color"
          nodeLabel={nodeLabel}
          nodeOpacity={0.92}
          linkColor={(l) => (l.dim ? LINK_DIM_COLOR : LINK_COLOR)}
          /* 边粗细 = 超出阈值的强度（与 2D 视图同口径） */
          linkWidth={(l) => 0.4 + Math.min(2.4, Math.max(0, l.sim - threshold) * 8)}
          linkOpacity={0.35}
          /* 强边带流动粒子（视觉引导相似度强弱） */
          linkDirectionalParticles={(l) => (!l.dim && l.sim - threshold > 0.08 ? 1 : 0)}
          linkDirectionalParticleWidth={1.3}
          linkDirectionalParticleSpeed={0.005}
          onNodeClick={(n) => onNodeClick?.(n.raw)}
          /* wiki 词条节点：默认球体之外叠加八面体线框光晕（nodeThreeObjectExtend
             为真时自定义对象是「附加」而非替换，chunk 节点不受影响返回 null） */
          nodeThreeObjectExtend={(n) => n.type === 'wiki'}
          nodeThreeObject={(n) => {
            if (n.type !== 'wiki') return null
            const mesh = new THREE.Mesh(wikiHaloGeo, wikiHaloMat)
            // 光晕包在球体外侧：半径 = cbrt(val) * nodeRelSize 的 1.45 倍
            const r = Math.cbrt(n.val ?? 8) * 5 * 1.45
            mesh.scale.setScalar(r)
            return mesh
          }}
          /* 拖拽结束重新钉住节点：库默认在 dragend 释放 fx/fy/fz 锁定，
             节点会被力弹回原位；这里固定到松手位置（对齐 2D 可拖拽行为） */
          onNodeDragEnd={(n) => {
            n.fx = n.x
            n.fy = n.y
            n.fz = n.z
          }}
          /* 隐藏库自带导航角标（页脚已有交互提示） */
          showNavInfo={false}
          /* 预热 20 帧再渲染，避免初始爆炸式散开；6 秒后布局收敛停机 */
          warmupTicks={20}
          cooldownTime={6000}
        />
      )}
    </div>
  )
}
