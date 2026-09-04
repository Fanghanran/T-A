import * as React from 'react'
import { Loader2, RotateCcw, SlidersHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { CollapsibleSection } from './CollapsibleSection'
import { fetchTunables, setTunable, resetTunables } from '@/lib/managementApi'

/**
 * 调优参数分区：分组展示、行内编辑保存、逐项恢复默认 / 全部恢复默认。
 * 修改经 PATCH /api/management/tunables/:key 校验并热生效。
 */
export function TunablesSection({ onError }) {
  const [data, setData] = React.useState(null)
  const [loading, setLoading] = React.useState(false)
  const [savingKey, setSavingKey] = React.useState('')
  const [drafts, setDrafts] = React.useState({}) // key → 输入框草稿值

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const d = await fetchTunables()
      setData(d)
      setDrafts({})
    } catch (err) {
      onError?.(err.message || '加载调优参数失败')
    } finally {
      setLoading(false)
    }
  }, [onError])

  React.useEffect(() => {
    load()
  }, [load]) // 分区挂载即预取（折叠时数据也已就绪，展开即显示）

  const draftOf = (t) => drafts[t.key] ?? String(t.value)

  const handleSave = async (t) => {
    const raw = draftOf(t).trim()
    const value = t.type === 'bool' ? raw === 'true' : raw
    setSavingKey(t.key)
    onError?.('')
    try {
      const { item } = await setTunable(t.key, value)
      setData((prev) =>
        prev
          ? {
              ...prev,
              groups: prev.groups.map((g) => ({
                ...g,
                items: g.items.map((x) => (x.key === t.key ? item : x)),
              })),
            }
          : prev,
      )
      setDrafts((prev) => {
        const next = { ...prev }
        delete next[t.key]
        return next
      })
    } catch (err) {
      onError?.(`保存 ${t.label} 失败：${err.message}`)
    } finally {
      setSavingKey('')
    }
  }

  const handleResetAll = async () => {
    try {
      await resetTunables()
      await load()
    } catch (err) {
      onError?.(err.message || '恢复默认失败')
    }
  }

  return (
    <CollapsibleSection
      icon={<SlidersHorizontal className="h-3.5 w-3.5" />}
      title="调优参数"
      hint="切片 / 评分 / 去重 / 查询改写阈值，修改即热生效并持久化"
      badge={
        data?.modified > 0 ? (
          <Badge variant="secondary" className="text-[10px]">
            {data.modified} 项已改
          </Badge>
        ) : null
      }
    >
      {loading && !data && (
        <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          加载中…
        </div>
      )}
      {data?.modified > 0 && (
        <div className="flex justify-end">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 gap-1 text-xs"
            onClick={handleResetAll}
          >
            <RotateCcw className="h-3 w-3" />
            全部恢复默认
          </Button>
        </div>
      )}
      {data?.groups?.map((g) => (
        <Card key={g.key} className="py-0">
          <CardContent className="p-4">
            <div className="mb-2 flex items-baseline gap-2">
              <span className="text-[13px] font-semibold">{g.label}</span>
              <span className="text-[11px] text-muted-foreground">
                {g.description}
              </span>
            </div>
            <div className="flex flex-col divide-y divide-border">
              {g.items.map((t) => {
                const dirty = draftOf(t) !== String(t.value)
                return (
                  <div key={t.key} className="flex items-center gap-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[13px]">{t.label}</span>
                        <code className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                          {t.key}
                        </code>
                        {t.modified && (
                          <Badge
                            variant="secondary"
                            className="px-1.5 py-0 text-[10px]"
                          >
                            已改（默认 {String(t.default)}）
                          </Badge>
                        )}
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground/80">
                        {t.description}
                        {t.min !== undefined && `（范围 ${t.min}~${t.max}）`}
                      </p>
                    </div>
                    {t.type === 'bool' ? (
                      <Button
                        type="button"
                        size="sm"
                        variant={t.value ? 'default' : 'outline'}
                        className="h-8 shrink-0 text-xs"
                        onClick={() => {
                          setSavingKey(t.key)
                          setTunable(t.key, !t.value)
                            .then(({ item }) => {
                              setData((prev) =>
                                prev
                                  ? {
                                      ...prev,
                                      groups: prev.groups.map((gg) => ({
                                        ...gg,
                                        items: gg.items.map((x) =>
                                          x.key === t.key ? item : x,
                                        ),
                                      })),
                                    }
                                  : prev,
                              )
                            })
                            .catch((err) =>
                              onError?.(`修改 ${t.label} 失败：${err.message}`),
                            )
                            .finally(() => setSavingKey(''))
                        }}
                        disabled={savingKey === t.key}
                      >
                        {savingKey === t.key ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : t.value ? (
                          '开'
                        ) : (
                          '关'
                        )}
                      </Button>
                    ) : (
                      <div className="flex shrink-0 items-center gap-1.5">
                        <Input
                          className="h-8 w-28 text-right text-[13px]"
                          value={draftOf(t)}
                          inputMode={
                            t.type === 'int' || t.type === 'float'
                              ? 'decimal'
                              : undefined
                          }
                          onChange={(e) =>
                            setDrafts((prev) => ({
                              ...prev,
                              [t.key]: e.target.value,
                            }))
                          }
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && dirty) handleSave(t)
                          }}
                        />
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-8 text-xs"
                          disabled={!dirty || savingKey === t.key}
                          onClick={() => handleSave(t)}
                        >
                          {savingKey === t.key ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            '保存'
                          )}
                        </Button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      ))}
    </CollapsibleSection>
  )
}
