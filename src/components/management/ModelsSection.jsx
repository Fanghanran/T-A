import * as React from 'react'
import { Bot, Loader2, Pencil, Plus, Trash2, CheckCircle2, XCircle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { CollapsibleSection } from '@/components/management/CollapsibleSection'
import {
  fetchModels,
  saveModelProfile,
  deleteModelProfile,
  updateModelRoutes,
  testModelProfile,
} from '@/lib/managementApi'
import { cn } from '@/lib/utils'

const EMPTY_DRAFT = {
  id: '',
  kind: 'chat',
  label: '',
  baseUrl: '',
  apiKeyRef: '',
  apiKeyInline: '',
  model: '',
  enabled: true,
}

/**
 * ModelsSection —— 模型管理分区（ADR-006）
 *
 * 三块：模型 profile 列表（新增/编辑/测试/删除）· 角色路由矩阵 · 智能体绑定。
 * 保存即热生效（服务端重建 provider 缓存）；修改 embedding 默认模型需重建向量集合。
 */
export function ModelsSection() {
  const [data, setData] = React.useState(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState('')
  const [editing, setEditing] = React.useState(null) // 正在编辑的 draft（null = 关闭表单）
  const [testing, setTesting] = React.useState('')
  const [testResult, setTestResult] = React.useState({})
  const [saving, setSaving] = React.useState(false)
  const [confirmDelete, setConfirmDelete] = React.useState(null)

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      setData(await fetchModels())
      setError('')
    } catch (err) {
      setError(err.message || '加载模型配置失败')
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    load()
  }, [load])

  const profiles = data?.profiles ?? []
  const roles = data?.roles ?? []
  const chatProfiles = profiles.filter((p) => p.kind === 'chat')
  const embedProfiles = profiles.filter((p) => p.kind === 'embedding')

  /** 保存路由 patch 并刷新 */
  const patchRoutes = async (patch) => {
    setSaving(true)
    try {
      await updateModelRoutes(patch)
      await load()
    } catch (err) {
      setError(err.message || '保存路由失败')
    } finally {
      setSaving(false)
    }
  }

  const saveProfile = async () => {
    setSaving(true)
    try {
      await saveModelProfile(editing)
      setEditing(null)
      await load()
    } catch (err) {
      setError(err.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const runTest = async (id) => {
    setTesting(id)
    try {
      const r = await testModelProfile(id)
      setTestResult((prev) => ({ ...prev, [id]: r }))
    } catch (err) {
      setTestResult((prev) => ({ ...prev, [id]: { ok: false, error: err.message } }))
    } finally {
      setTesting('')
    }
  }

  const RoleSelect = ({ roleKey, value, disabled }) => (
    <select
      className="h-7 rounded-md border border-input bg-background px-1.5 text-xs"
      value={value ?? ''}
      disabled={disabled || saving}
      onChange={(e) => patchRoutes({ roles: { [roleKey]: e.target.value || null } })}
      aria-label={`角色 ${roleKey} 绑定的模型`}
    >
      <option value="">默认</option>
      {chatProfiles.map((p) => (
        <option key={p.id} value={p.id}>{p.label || p.id}</option>
      ))}
    </select>
  )

  return (
    <CollapsibleSection
      icon={<Bot className="h-3.5 w-3.5" />}
      title="模型管理"
      hint="多模型 profile 与路由绑定，保存即热生效（无需重启）"
      badge={data?.profiles?.length ? (
        <Badge variant="secondary" className="text-[10px]">{data.profiles.length} 个模型</Badge>
      ) : null}
    >
      {loading && !data && (
        <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          加载中…
        </div>
      )}
      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>
      )}

      {data && (
        <div className="flex flex-col gap-3">
          {/* 模型 profile 列表 */}
          <div className="flex flex-col divide-y divide-border/60 rounded-md border">
            {profiles.map((p) => {
              const tr = testResult[p.id]
              return (
                <div key={p.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
                  <span className="text-[13px] font-medium">{p.label || p.id}</span>
                  <Badge variant="outline" className="px-1.5 py-0 text-[10px]">{p.kind === 'chat' ? '对话' : '向量'}</Badge>
                  <code className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{p.model}</code>
                  {p.baseUrl && <span className="hidden truncate text-[10px] text-muted-foreground md:inline">{p.baseUrl}</span>}
                  <span className="ml-auto flex items-center gap-1.5">
                    <Button type="button" variant="ghost" size="sm" className="h-6 gap-1 px-2 text-[11px]" disabled={testing === p.id} onClick={() => runTest(p.id)}>
                      {testing === p.id ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                      测试
                    </Button>
                    {!p.seeded && (
                      <Button type="button" variant="ghost" size="icon" className="h-6 w-6" aria-label="删除模型" onClick={() => setConfirmDelete(p)}>
                        <Trash2 className="h-3 w-3 text-muted-foreground hover:text-destructive" />
                      </Button>
                    )}
                  </span>
                  <div className="w-full">
                    <span className="mr-2 text-[10px] text-muted-foreground">Key：{p.keyPreview}</span>
                    {tr && (
                      <span className={cn('text-[11px]', tr.ok ? 'text-emerald-600' : 'text-destructive')}>
                        {tr.ok ? `连通 ✓（${tr.latencyMs}ms${tr.dim ? ` · ${tr.dim} 维` : ''}）` : `失败：${tr.error || tr.errorText || '未知错误'}`}
                      </span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          {/* 角色路由矩阵 */}
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">角色路由（留空 = 使用默认对话模型）</p>
            <div className="flex flex-col gap-1 rounded-md border p-2.5">
              {roles.filter((r) => r.kind === 'chat').map((r) => (
                <div key={r.key} className="flex items-center gap-2 text-xs">
                  <span className="w-32 shrink-0 text-muted-foreground">{r.label}</span>
                  <code className="rounded bg-muted px-1 py-0.5 text-[10px]">{r.key}</code>
                  <div className="ml-auto">
                    <RoleSelect roleKey={r.key} value={data.routes.roles[r.key]} disabled={saving} />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* 智能体绑定 */}
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">智能体绑定（优先级高于角色路由）</p>
            <div className="flex flex-col gap-1 rounded-md border p-2.5">
              {data.agents.map((a) => (
                <div key={a.id} className="flex items-center gap-2 text-xs">
                  <span className="w-32 shrink-0 text-muted-foreground">{a.name}</span>
                  <code className="rounded bg-muted px-1 py-0.5 text-[10px]">{a.id}</code>
                  <div className="ml-auto">
                    <select
                      className="h-7 rounded-md border border-input bg-background px-1.5 text-xs"
                      value={data.routes.agents[a.id] ?? ''}
                      disabled={saving}
                      onChange={(e) => patchRoutes({ agents: { [a.id]: e.target.value || null } })}
                      aria-label={`智能体 ${a.name} 绑定的模型`}
                    >
                      <option value="">跟随角色默认</option>
                      {chatProfiles.map((p) => (
                        <option key={p.id} value={p.id}>{p.label || p.id}</option>
                      ))}
                    </select>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* 默认模型 */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">默认对话模型</p>
              <select
                className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                value={data.routes.defaults.chat ?? ''}
                disabled={saving}
                onChange={(e) => patchRoutes({ defaults: { chat: e.target.value } })}
                aria-label="默认对话模型"
              >
                {chatProfiles.map((p) => (
                  <option key={p.id} value={p.id}>{p.label || p.id}</option>
                ))}
              </select>
            </div>
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">默认向量模型</p>
              <select
                className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                value={data.routes.defaults.embedding ?? ''}
                disabled={saving}
                onChange={(e) => patchRoutes({ defaults: { embedding: e.target.value } })}
                aria-label="默认向量模型"
              >
                {embedProfiles.map((p) => (
                  <option key={p.id} value={p.id}>{p.label || p.id}</option>
                ))}
              </select>
              <p className="mt-1 text-[10px] text-amber-700 dark:text-amber-400">
                切换不同维度的向量模型需重建向量集合，否则入库/检索会报维度错误。
              </p>
            </div>
          </div>

          {/* 新增模型入口 */}
          <div>
            <Button type="button" variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={() => setEditing({ ...EMPTY_DRAFT })}>
              <Plus className="h-3 w-3" />
              新增模型
            </Button>
          </div>

          {editing && (
            <Card>
              <CardContent className="flex flex-col gap-2 p-4">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <label className="flex flex-col gap-1 text-xs">
                    <span className="text-muted-foreground">ID（英文 slug）</span>
                    <Input className="h-8 text-xs" value={editing.id} disabled={!!profiles.find((x) => x.id === editing.id)}
                      onChange={(e) => setEditing((d) => ({ ...d, id: e.target.value }))} placeholder="如 my-qwen" />
                  </label>
                  <label className="flex flex-col gap-1 text-xs">
                    <span className="text-muted-foreground">显示名称</span>
                    <Input className="h-8 text-xs" value={editing.label ?? ''} onChange={(e) => setEditing((d) => ({ ...d, label: e.target.value }))} placeholder="如 通义千问" />
                  </label>
                  <label className="flex flex-col gap-1 text-xs">
                    <span className="text-muted-foreground">类型</span>
                    <select className="h-8 rounded-md border border-input bg-background px-2 text-xs" value={editing.kind}
                      onChange={(e) => setEditing((d) => ({ ...d, kind: e.target.value }))}>
                      <option value="chat">对话 LLM</option>
                      <option value="embedding">向量模型</option>
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-xs">
                    <span className="text-muted-foreground">模型 ID</span>
                    <Input className="h-8 text-xs" value={editing.model ?? ''} onChange={(e) => setEditing((d) => ({ ...d, model: e.target.value }))} placeholder="如 qwen2.5-coder:14b" />
                  </label>
                  <label className="flex flex-col gap-1 text-xs sm:col-span-2">
                    <span className="text-muted-foreground">Base URL（留空 = 官方 OpenAI）</span>
                    <Input className="h-8 text-xs" value={editing.baseUrl ?? ''} onChange={(e) => setEditing((d) => ({ ...d, baseUrl: e.target.value }))} placeholder="如 http://localhost:11434/v1" />
                  </label>
                  <label className="flex flex-col gap-1 text-xs">
                    <span className="text-muted-foreground">API Key 环境变量名（推荐）</span>
                    <Input className="h-8 text-xs" value={editing.apiKeyRef ?? ''} onChange={(e) => setEditing((d) => ({ ...d, apiKeyRef: e.target.value }))} placeholder="如 LLM_API_KEY" />
                  </label>
                  <label className="flex flex-col gap-1 text-xs">
                    <span className="text-muted-foreground">API Key 明文（不入库选项，也可留空）</span>
                    <Input className="h-8 text-xs" type="password" value={editing.apiKeyInline ?? ''} onChange={(e) => setEditing((d) => ({ ...d, apiKeyInline: e.target.value }))} placeholder="留空则只用上方环境变量" />
                  </label>
                </div>
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setEditing(null)}>取消</Button>
                  <Button type="button" size="sm" className="h-7 text-xs" disabled={saving || !editing.id || !editing.model} onClick={saveProfile}>
                    {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                    保存
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* 删除确认（被路由引用的由后端 400 拒绝并提示） */}
      <ConfirmDialog
        open={!!confirmDelete}
        onOpenChange={(v) => !v && setConfirmDelete(null)}
        destructive
        title="删除模型"
        description={`确定删除「${confirmDelete?.label || confirmDelete?.id}」吗？正被路由引用的会删除失败。`}
        confirmLabel="确认删除"
        onConfirm={async () => {
          const target = confirmDelete
          setConfirmDelete(null)
          try {
            await deleteModelProfile(target.id)
            await load()
          } catch (err) {
            setError(err.message || '删除失败')
          }
        }}
      />
    </CollapsibleSection>
  )
}

export default ModelsSection
