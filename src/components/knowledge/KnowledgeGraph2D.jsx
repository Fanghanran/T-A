import * as React from 'react'
import * as echarts from 'echarts/core'
import { GraphChart } from 'echarts/charts'
import { TooltipComponent, LegendComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import {
  computeGroupedLayout,
  esc,
  truncate,
  ECHARTS_PALETTE,
  WIKI_COLOR,
  FORCE_LIMIT,
} from '@/lib/knowledgeGraphShared'

echarts.use([GraphChart, TooltipComponent, LegendComponent, CanvasRenderer])

/**
 * KnowledgeGraph2D —— 知识网络图 2D 视图（ECharts 力导向）
 *
 * 从 KnowledgeGraphCard 抽取的 2D 渲染组件，卡片与独立页面共用：
 *  - 节点 = 知识切片（按文档着色）/ wiki 词条（琥珀菱形，类别挂图例末位）
 *  - 大图模式（> FORCE_LIMIT）：预布局 + large 渲染管线 + progressive
 *  - 点击节点回调 onNodeClick（父组件决定跳转或打开词条面板）
 *
 * 挂载即初始化图表，卸载即销毁；父组件通过 chartRef 拿到实例
 * 做 dispatchAction（Enter 定位 tooltip 等）。
 *
 * @param {Object} props
 * @param {Object} props.view 共享派生视图（nodes/edges/degree/matched/kw）
 * @param {Array} props.docs 文档列表（图例 + 类别着色）
 * @param {number} props.threshold 当前相似度阈值（边粗细基准）
 * @param {{current:Object|null}} props.chartRef 父组件持有的图表实例 ref
 * @param {(node:Object)=>void} [props.onNodeClick] 节点点击回调（原始节点对象）
 */
export function KnowledgeGraph2D({ view, docs, threshold, chartRef, onNodeClick }) {
  const containerRef = React.useRef(null)
  // 点击闭包需要最新 view，挂 ref
  const viewRef = React.useRef(null)
  viewRef.current = view

  /** 是否含 wiki 词条节点（决定图例追加与调色板扩展） */
  const hasWiki = React.useMemo(
    () => (view?.nodes ?? []).some((n) => n.type === 'wiki'),
    [view],
  )
  const wikiCategory = (docs ?? []).length

  /** ECharts option（≤FORCE_LIMIT 力导向；超过切大图模式：预布局 + large 渲染） */
  const option = React.useMemo(() => {
    if (!view) return null
    const docIndex = new Map((docs ?? []).map((d, i) => [d.id, i]))
    const isDim = (n) => {
      if (view.kw) return !view.matched.has(n.id)
      return (view.degree.get(n.id) ?? 0) === 0
    }
    // 大图模式：预计算分组布局 + 压缩节点尺寸（万级节点 force 迭代不可用）
    const isLarge = view.nodes.length > FORCE_LIMIT
    const layoutPos = isLarge ? computeGroupedLayout(view.nodes) : null
    const nodes = view.nodes.map((n, i) => {
      const isWiki = n.type === 'wiki'
      const deg = view.degree.get(n.id) ?? 0
      return {
        id: n.id,
        // 节点类型透传（chunk / wiki）
        type: n.type ?? 'chunk',
        name: isWiki
          ? n.name || n.heading || n.id
          : n.heading || n.topic || `切片 ${n.idx}`,
        // wiki 词条类别挂图例末位（「Wiki 词条」），可整组开关
        category: isWiki ? wikiCategory : (docIndex.get(n.docId) ?? 0),
        symbol: isWiki ? 'diamond' : 'circle',
        symbolSize: isWiki
          ? isLarge
            ? 5 + Math.min(7, deg * 0.5)
            : 10 + Math.min(16, deg * 1.2)
          : isLarge
            ? 4.5 + Math.min(6, deg * 0.6)
            : 8 + Math.min(20, deg * 2.2),
        itemStyle: isWiki
          ? { color: WIKI_COLOR, opacity: isDim(n) ? 0.12 : 0.95 }
          : isDim(n)
            ? { opacity: 0.12 }
            : undefined,
        ...(layoutPos ? layoutPos[i] : {}),
      }
    })
    const edges = view.edges.map((e) => {
      // 关键词模式下仅保留两端均命中的边，其余近乎隐藏
      const both =
        !view.kw || (view.matched.has(e.source) && view.matched.has(e.target))
      const over = e.similarity - threshold
      return {
        source: e.source,
        target: e.target,
        value: e.similarity,
        kind: e.kind,
        lineStyle: {
          color: '#94a3b8',
          width: isLarge ? 0.4 : 0.5 + Math.min(2.5, over * 8),
          opacity: both
            ? isLarge
              ? 0.1 + Math.min(0.3, over * 1.2)
              : 0.15 + Math.min(0.55, over * 2.5)
            : 0.02,
          curveness: isLarge ? 0 : 0.12,
        },
      }
    })
    return {
      // 显式调色板（前 9 色与 ECharts 默认一致，保文档着色不变），
      // 末位追加词条色 → 图例「Wiki 词条」图标色与节点色一致
      color: [...ECHARTS_PALETTE, WIKI_COLOR],
      tooltip: {
        confine: true,
        textStyle: { fontSize: 12 },
        formatter: (p) => {
          const v = viewRef.current
          if (!v) return ''
          if (p.dataType === 'edge') {
            const a = v.nodeById.get(p.data.source)
            const b = v.nodeById.get(p.data.target)
            const sim = Number(p.data.value ?? 0)
            const label =
              p.data.kind === 'mention'
                ? '词条提及'
                : `相似度 ${sim.toFixed(3)}`
            return `<div style="max-width:280px">
              <div style="font-weight:600;margin-bottom:2px">${esc(a?.name || a?.heading || a?.topic || a?.id || '')} ↔ ${esc(b?.name || b?.heading || b?.topic || b?.id || '')}</div>
              <div style="color:#71717a;font-size:11px">${label}</div>
            </div>`
          }
          const n = v.nodeById.get(p.data.id)
          if (!n) return ''
          if (n.type === 'wiki') {
            const summary = String(n.summary ?? '')
            const clipped =
              summary.length > 200 ? `${summary.slice(0, 200)}…` : summary
            return `<div style="max-width:300px">
              <div style="font-weight:600;margin-bottom:2px">${esc(n.name || n.heading || n.id)}</div>
              <div style="color:#71717a;font-size:11px">${esc(n.topic || '词条')} · 提及 ${n.degree ?? 0} 处</div>
              ${clipped ? `<div style="font-size:11px;margin-top:4px;line-height:1.5">${esc(clipped)}</div>` : ''}
            </div>`
          }
          return `<div style="max-width:300px">
            <div style="font-weight:600;margin-bottom:2px">${esc(n.heading || n.topic || `切片 ${n.idx}`)}</div>
            <div style="color:#71717a;font-size:11px">${esc(n.docTitle)} · 关联 ${v.degree.get(n.id) ?? 0}</div>
            <div style="font-size:11px;margin-top:4px;line-height:1.5">${esc(n.snippet)}</div>
          </div>`
        },
      },
      legend: {
        type: 'scroll',
        bottom: 0,
        icon: 'circle',
        itemWidth: 8,
        itemHeight: 8,
        textStyle: { color: '#8b8f98', fontSize: 11 },
        formatter: (name) => truncate(name),
      },
      series: [
        {
          type: 'graph',
          name: '切片',
          // 大图模式：预布局坐标 + large 渲染管线 + progressive 渐进渲染
          ...(isLarge
            ? {
                layout: 'none',
                large: true,
                progressive: 2000,
                progressiveThreshold: 1500,
              }
            : {
                layout: 'force',
                force: { repulsion: 90, edgeLength: [40, 130], gravity: 0.08 },
              }),
          roam: true,
          draggable: !isLarge,
          categories: [
            ...(docs ?? []).map((d) => ({ name: d.title })),
            // 有 wiki 节点时追加词条类别（图例可整组显示/隐藏）
            ...(hasWiki ? [{ name: 'Wiki 词条' }] : []),
          ],
          data: nodes,
          edges,
          label: { show: false },
          // large 渲染管线不支持邻域聚焦，大图模式关闭 emphasis
          emphasis: isLarge
            ? { disabled: true }
            : {
                focus: 'adjacency',
                label: { show: true, formatter: (p) => truncate(p.name, 18) },
              },
          scaleLimit: { min: 0.2, max: isLarge ? 12 : 4 },
        },
      ],
    }
  }, [view, docs, threshold, hasWiki, wikiCategory])

  /** 初始化图表实例 + 窗口自适应 + 点击回调；卸载销毁 */
  // onNodeClick 挂 ref：父组件传入的内联回调身份每次渲染都变，
  // 直接进依赖会导致图表销毁重建（丢失缩放/平移状态）
  const onNodeClickRef = React.useRef(null)
  onNodeClickRef.current = onNodeClick
  React.useEffect(() => {
    if (!containerRef.current) return
    const chart = echarts.init(containerRef.current)
    chartRef.current = chart
    const onResize = () => chart.resize()
    window.addEventListener('resize', onResize)
    chart.on('click', (params) => {
      if (params.componentType !== 'series' || params.dataType !== 'node') return
      const n = viewRef.current?.nodeById.get(params.data.id)
      if (!n) return
      onNodeClickRef.current?.(n)
    })
    return () => {
      window.removeEventListener('resize', onResize)
      chart.dispose()
      chartRef.current = null
    }
  }, [chartRef])

  /** option 变化（数据 / 阈值 / 关键词）→ 更新图表 */
  React.useEffect(() => {
    if (!chartRef.current || !option) return
    chartRef.current.setOption(option)
  }, [option, chartRef])

  return <div ref={containerRef} className="h-full w-full" />
}

export default KnowledgeGraph2D
