import * as React from 'react'
import { listCategories, listTags } from '@/lib/knowledgeApi'
import { child } from '@/lib/logger'

const log = child('knowledge:facets')

/**
 * useDocumentFacets —— 知识库分类 / 标签聚合
 */
export function useDocumentFacets() {
  const [categories, setCategories] = React.useState([])
  const [tags, setTags] = React.useState([])

  const loadFacets = React.useCallback(async () => {
    try {
      const [cats, tgs] = await Promise.all([listCategories(), listTags()])
      setCategories(cats ?? [])
      setTags(tgs ?? [])
      return { cats: cats ?? [], tags: tgs ?? [] }
    } catch (e) {
      log.error('[useDocumentFacets] 分类/标签加载失败：', e)
      return { cats: [], tags: [] }
    }
  }, [])

  return { categories, tags, loadFacets }
}
