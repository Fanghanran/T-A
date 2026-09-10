import * as React from 'react'
import { Database, Loader2, RefreshCw, SlidersHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { PageHeader } from '@/components/layout/PageHeader'
import { fetchEsStatus, syncEsIndex } from '@/lib/managementApi'
import { SectionTitle } from '@/components/management/SectionTitle'
import { TunablesSection } from '@/components/management/TunablesSection'
import { UsersSection } from '@/components/management/UsersSection'

/**
 * ParamsManagePage —— 参数管理页（系统管理子菜单）
 *
 * 三块：ES 关键词索引（状态/偏差/回填） · 调优参数 · 用户令牌。
 * （操作审计已独立为系统管理的「操作审计」子菜单）
 */
export function ParamsManagePage() {
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState('')
  const [es, setEs] = React.useState(null)
  const [esSyncing, setEsSyncing] = React.useState(false)

  const load = React.useCallback(async () => {
    setLoading(true)
    setError('')
    // ES 状态独立加载：后端未启 ES 时 502 也只是这一块显示错误，不影响整页
    try {
      setEs(await fetchEsStatus())
    } catch {
      setEs(null)
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    load()
  }, [load])

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        icon={SlidersHorizontal}
        title="参数管理"
        description="调优参数 · ES 关键词索引 · 用户令牌"
      >
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-8 gap-1.5"
          onClick={load}
          disabled={loading}
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          {loading ? '刷新中…' : '刷新'}
        </Button>
      </PageHeader>

      <div className="flex-1 overflow-auto scrollbar-thin">
        <div className="mx-auto max-w-5xl animate-page-in px-4 py-6 md:px-6">
          {error && (
            <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          {/* ===== ES 关键词索引（状态 + 偏差 + 回填） ===== */}
          <section>
            <SectionTitle
              icon={<Database className="h-3.5 w-3.5" />}
              title="ES 关键词索引"
            />
            <Card className="py-0">
              <CardContent className="p-0">
                <div className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <span className="shrink-0 text-[13px] font-medium">BM25 召回通道</span>
                    <span className="min-w-0 truncate text-xs text-muted-foreground/80">
                      精确术语独立召回（与 Milvus 向量互补）；入库自动双写
                    </span>
                  </div>
                  {es === null ? (
                    <span className="text-xs text-muted-foreground">
                      状态获取失败（服务未启动或未启用）
                    </span>
                  ) : !es.enabled ? (
                    <Badge variant="outline" className="text-xs">未启用</Badge>
                  ) : (
                    <>
                      <Badge
                        variant={es.drift === 0 ? 'secondary' : 'destructive'}
                        className="text-xs"
                      >
                        ES {es.esCount} / Milvus {es.milvusCount}
                        {es.drift === 0 ? ' · 一致' : ` · 偏差 ${es.drift}`}
                      </Badge>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-7 gap-1.5 text-xs"
                        disabled={esSyncing}
                        onClick={async () => {
                          setEsSyncing(true)
                          try {
                            await syncEsIndex()
                            setEs(await fetchEsStatus())
                          } catch (err) {
                            setError(err.message || '回填失败')
                          } finally {
                            setEsSyncing(false)
                          }
                        }}
                      >
                        {esSyncing ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <RefreshCw className="h-3 w-3" />
                        )}
                        {esSyncing ? '回填中…' : '全量回填'}
                      </Button>
                    </>
                  )}
                </div>
              </CardContent>
            </Card>
          </section>

          {/* ===== 调优参数 ===== */}
          <div className="mt-6">
            <TunablesSection onError={setError} />
          </div>

          {/* ===== 用户令牌 ===== */}
          <div className="mt-6">
            <UsersSection />
          </div>
        </div>
      </div>
    </div>
  )
}

export default ParamsManagePage
