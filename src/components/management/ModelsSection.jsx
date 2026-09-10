import * as React from 'react'
import { Bot, Loader2, Plus, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { SearchableModelSelect } from '@/components/ui/SearchableModelSelect'
import {
  fetchModels,
  saveModelProfile,
  deleteModelProfile,
  updateModelRoutes,
  updateModelSettings,
  testModelProfile,
  discoverModels,
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
 * baseUrl 归一化：容器场景服务发现返回 host.docker.internal，与本地注册的
 * localhost / 127.0.0.1 视为同源，避免已注册模型重复出现在「未注册」选项区。
 */
function normUrl(u) {
  return (u || '')
    .replace(/host\.docker\.internal/gi, 'localhost')
    .replace(/127\.0\.0\.1/g, 'localhost')
    .replace(/\/+$/, '')
    .toLowerCase()
}

/**
 * ModelsSection —— 模型管理分区（ADR-006）
 *
 * 三块：模型 profile 列表（新增/编辑/测试/删除）· 角色路由矩阵 · 智能体绑定。
 * 保存即热生效（服务端重建 provider 缓存）；修改 embedding 默认模型需重建向量集合。
 *
 * 服务模型发现：挂载后从已启用 profile 的服务拉取可用模型列表（Ollama /api/tags
 * 优先，OpenAI /v1/models 回落），未注册模型以「未注册 · 选用即添加」出现在各
 * 下拉选项中——选中后自动创建 profile（baseUrl/密钥引用继承同源已注册 profile）
 * 并执行对应路由绑定。
 */
export function ModelsSection({ onLoadingChange }) {
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

  React.useEffect(() => {
    onLoadingChange?.(loading)
  }, [loading, onLoadingChange])

  // 服务模型发现：挂载后拉取一次（失败置空并保留 errors 供展示，不影响已注册模型使用）
  const [discovered, setDiscovered] = React.useState(null)
  React.useEffect(() => {
    let alive = true
    discoverModels()
      .then((d) => alive && setDiscovered(d))
      .catch(() => alive && setDiscovered({ items: [], errors: [] }))
    return () => {
      alive = false
    }
  }, [])

  const profiles = data?.profiles ?? []
  const roles = data?.roles ?? []
  const chatProfiles = React.useMemo(
    () => (data?.profiles ?? []).filter((p) => p.kind === 'chat'),
    [data],
  )
  const embedProfiles = React.useMemo(
    () => (data?.profiles ?? []).filter((p) => p.kind === 'embedding'),
    [data],
  )

  // 已注册模型键集（baseUrl 归一化后与 model 名比对，跨 localhost/host.docker.internal 同源去重）
  const registeredKeys = React.useMemo(
    () =>
      new Set(
        (data?.profiles ?? []).map(
          (p) => `${normUrl(p.baseUrl)}|${(p.model || '').toLowerCase()}`,
        ),
      ),
    [data],
  )

  /** 合并已注册 profile 与服务发现的未注册模型为一个下拉选项集 */
  const mergeOptions = React.useCallback(
    (kind, registered) => [
      ...registered,
      ...(discovered?.items ?? [])
        .filter(
          (d) =>
            d.kind === kind &&
            !registeredKeys.has(
              `${normUrl(d.baseUrl)}|${d.model.toLowerCase()}`,
            ),
        )
        .map((d) => ({
          id: `new:${d.model}`,
          label: d.model,
          model: d.model,
          unregistered: true,
        })),
    ],
    [discovered, registeredKeys],
  )

  const chatOptions = React.useMemo(
    () => mergeOptions('chat', chatProfiles),
    [mergeOptions, chatProfiles],
  )
  const embedOptions = React.useMemo(
    () => mergeOptions('embedding', embedProfiles),
    [mergeOptions, embedProfiles],
  )

  /**
   * 选用未注册的服务模型：自动建档（id 从模型名 slug 生成并避让已占用；
   * baseUrl / apiKeyRef 继承同源已注册 profile 的原值，容器与本地地址口径
   * 以注册表为准）后执行对应路由绑定。
   */
  const adoptAndApply = async (pseudoId, kind, applyRoute) => {
    const model = pseudoId.slice('new:'.length)
    const entry = (discovered?.items ?? []).find((d) => d.model === model)
    if (!entry) return
    setSaving(true)
    setError('')
    try {
      const origin = profiles.find(
        (p) => p.kind === kind && normUrl(p.baseUrl) === normUrl(entry.baseUrl),
      )
      const base =
        model
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 60) || 'model'
      let id = base
      let n = 2
      while (profiles.some((p) => p.id === id)) id = `${base}-${n++}`
      const keyRef = origin?.apiKeyRef || entry.apiKeyRef
      const { profile: saved } = await saveModelProfile({
        id,
        kind,
        label: model,
        baseUrl: origin?.baseUrl ?? entry.baseUrl,
        ...(keyRef ? { apiKeyRef: keyRef } : {}),
        model,
      })
      await applyRoute(saved.id)
    } catch (err) {
      setError(err.message || '添加模型失败')
    } finally {
      setSaving(false)
    }
  }

  /** 选择分发：伪 id（new: 前缀，未注册服务模型）走自动建档，否则直接执行路由变更 */
  const dispatchSelect = (kind, applyRoute) => (id) => {
    if (typeof id === 'string' && id.startsWith('new:')) {
      adoptAndApply(id, kind, applyRoute)
      return
    }
    applyRoute(id)
  }

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

  /** 保存运行时设置（思考模式）并刷新 */
  const patchSettings = async (patch) => {
    setSaving(true)
    try {
      await updateModelSettings(patch)
      await load()
    } catch (err) {
      setError(err.message || '保存设置失败')
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
      setTestResult((prev) => ({
        ...prev,
        [id]: { ok: false, error: err.message },
      }))
    } finally {
      setTesting('')
    }
  }

  const RoleSelect = ({ roleKey, value, disabled }) => (
    <SearchableModelSelect
      className="min-w-0 flex-1 sm:max-w-56"
      value={value ?? ''}
      options={chatOptions}
      emptyOptionLabel="默认"
      disabled={disabled || saving}
      onChange={dispatchSelect('chat', (pid) =>
        patchRoutes({ roles: { [roleKey]: pid || null } }),
      )}
    />
  )

  return (
    <div className="flex flex-col gap-4">
      {/* 分区头（独立页面主体，不再折叠） */}
      <div className="flex items-center gap-2">
        <Bot className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">模型配置</h3>
        <span className="text-xs text-muted-foreground">
          多模型 profile 与路由绑定，保存即热生效（无需重启）
        </span>
        {data?.profiles?.length ? (
          <Badge variant="secondary" className="ml-auto text-[10px]">
            {data.profiles.length} 个模型
          </Badge>
        ) : null}
      </div>

      {loading && !data && (
        <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          加载中…
        </div>
      )}
      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {data && (
        <div className="flex flex-col gap-3">
          {/* 模型 profile 列表 */}
          <div className="flex flex-col divide-y divide-border/60 rounded-md border">
            {profiles.map((p) => {
              const tr = testResult[p.id]
              return (
                <div
                  key={p.id}
                  className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs"
                >
                  <span className="text-[13px] font-medium">
                    {p.label || p.id}
                  </span>
                  <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                    {p.kind === 'chat' ? '对话' : '向量'}
                  </Badge>
                  <code className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {p.model}
                  </code>
                  {p.baseUrl && (
                    <span className="hidden truncate text-[10px] text-muted-foreground md:inline">
                      {p.baseUrl}
                    </span>
                  )}
                  <span className="ml-auto flex items-center gap-1.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 gap-1 px-2 text-[11px]"
                      disabled={testing === p.id}
                      onClick={() => runTest(p.id)}
                    >
                      {testing === p.id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : null}
                      测试
                    </Button>
                    {!p.seeded && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        aria-label="删除模型"
                        onClick={() => setConfirmDelete(p)}
                      >
                        <Trash2 className="h-3 w-3 text-muted-foreground hover:text-destructive" />
                      </Button>
                    )}
                  </span>
                  <div className="w-full">
                    <span className="mr-2 text-[10px] text-muted-foreground">
                      Key：{p.keyPreview}
                    </span>
                    {tr && (
                      <span
                        className={cn(
                          'text-[11px]',
                          tr.ok ? 'text-emerald-600' : 'text-destructive',
                        )}
                      >
                        {tr.ok
                          ? `连通 ✓（${tr.latencyMs}ms${tr.dim ? ` · ${tr.dim} 维` : ''}）`
                          : `失败：${tr.error || tr.errorText || '未知错误'}`}
                      </span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          {/* 角色路由矩阵 */}
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">
              角色路由（留空 = 使用默认对话模型）
            </p>
            <div className="flex flex-col gap-1 rounded-md border p-2.5">
              {roles
                .filter((r) => r.kind === 'chat')
                .map((r) => (
                  <div
                    key={r.key}
                    className="flex flex-wrap items-center gap-2 text-xs"
                  >
                    <span className="w-28 shrink-0 text-muted-foreground">
                      {r.label}
                    </span>
                    <code className="rounded bg-muted px-1 py-0.5 text-[10px]">
                      {r.key}
                    </code>
                    <div className="ml-auto flex min-w-40 flex-1 justify-end sm:flex-none">
                      <RoleSelect
                        roleKey={r.key}
                        value={data.routes.roles[r.key]}
                        disabled={saving}
                      />
                    </div>
                  </div>
                ))}
            </div>
          </div>

          {/* 智能体绑定 */}
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">
              智能体绑定（优先级高于角色路由）
            </p>
            <div className="flex flex-col gap-1 rounded-md border p-2.5">
              {data.agents.map((a) => (
                <div
                  key={a.id}
                  className="flex flex-wrap items-center gap-2 text-xs"
                >
                  <span className="w-28 shrink-0 text-muted-foreground">
                    {a.name}
                  </span>
                  <code className="rounded bg-muted px-1 py-0.5 text-[10px]">
                    {a.id}
                  </code>
                  <div className="ml-auto flex min-w-40 flex-1 justify-end sm:flex-none">
                    <SearchableModelSelect
                      className="min-w-0 flex-1 sm:max-w-56"
                      value={data.routes.agents[a.id] ?? ''}
                      options={chatOptions}
                      emptyOptionLabel="跟随角色默认"
                      disabled={saving}
                      onChange={dispatchSelect('chat', (pid) =>
                        patchRoutes({ agents: { [a.id]: pid || null } }),
                      )}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* 默认模型 */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">
                默认对话模型（可搜索，含服务上未注册模型）
              </p>
              <SearchableModelSelect
                value={data.routes.defaults.chat ?? ''}
                options={chatOptions}
                disabled={saving}
                onChange={dispatchSelect('chat', (pid) =>
                  patchRoutes({ defaults: { chat: pid } }),
                )}
              />
            </div>
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">
                默认向量模型
              </p>
              <SearchableModelSelect
                value={data.routes.defaults.embedding ?? ''}
                options={embedOptions}
                disabled={saving}
                onChange={dispatchSelect('embedding', (pid) =>
                  patchRoutes({ defaults: { embedding: pid } }),
                )}
              />
              <p className="mt-1 text-[10px] text-amber-700 dark:text-amber-400">
                切换不同维度的向量模型需重建向量集合，否则入库/检索会报维度错误。
              </p>
            </div>
          </div>

          {/* 服务发现失败源提示（显式报错不静默，不影响已注册模型使用） */}
          {discovered?.errors?.length > 0 && (
            <p className="text-[11px] text-amber-700 dark:text-amber-400">
              部分模型服务发现失败：
              {discovered.errors
                .map((e) => `${e.baseUrl}（${e.error}）`)
                .join('；')}
            </p>
          )}

          {/* 思考模式开关（qwen3 软开关，热生效） */}
          <label className="flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2">
            <input
              type="checkbox"
              className="mt-0.5 h-3.5 w-3.5"
              checked={data.settings?.thinking !== false}
              disabled={saving}
              onChange={(e) => patchSettings({ thinking: e.target.checked })}
            />
            <span className="flex flex-col">
              <span className="text-xs font-medium">思考模式（qwen3）</span>
              <span className="text-[11px] text-muted-foreground">
                开启后 qwen3
                系列模型先思维链推理再作答（质量更高、耗时更长）；关闭则注入
                /no_think 软开关跳过思考，RAG 问答与查询改写出字更快。仅影响
                qwen3 系列模型，切换热生效、随配置持久化。
              </span>
            </span>
          </label>

          {/* 新增模型入口 */}
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 gap-1 text-xs"
              onClick={() => setEditing({ ...EMPTY_DRAFT })}
            >
              <Plus className="h-3 w-3" />
              新增模型
            </Button>
          </div>

          {editing && (
            <Card>
              <CardContent className="flex flex-col gap-2 p-4">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <label className="flex flex-col gap-1 text-xs">
                    <span className="text-muted-foreground">
                      ID（英文 slug）
                    </span>
                    <Input
                      className="h-8 text-xs"
                      value={editing.id}
                      disabled={!!profiles.find((x) => x.id === editing.id)}
                      onChange={(e) =>
                        setEditing((d) => ({ ...d, id: e.target.value }))
                      }
                      placeholder="如 my-qwen"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs">
                    <span className="text-muted-foreground">显示名称</span>
                    <Input
                      className="h-8 text-xs"
                      value={editing.label ?? ''}
                      onChange={(e) =>
                        setEditing((d) => ({ ...d, label: e.target.value }))
                      }
                      placeholder="如 通义千问"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs">
                    <span className="text-muted-foreground">类型</span>
                    <select
                      className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                      value={editing.kind}
                      onChange={(e) =>
                        setEditing((d) => ({ ...d, kind: e.target.value }))
                      }
                    >
                      <option value="chat">对话 LLM</option>
                      <option value="embedding">向量模型</option>
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-xs">
                    <span className="text-muted-foreground">模型 ID</span>
                    <Input
                      className="h-8 text-xs"
                      value={editing.model ?? ''}
                      onChange={(e) =>
                        setEditing((d) => ({ ...d, model: e.target.value }))
                      }
                      placeholder="如 qwen2.5-coder:14b"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs sm:col-span-2">
                    <span className="text-muted-foreground">
                      Base URL（留空 = 官方 OpenAI）
                    </span>
                    <Input
                      className="h-8 text-xs"
                      value={editing.baseUrl ?? ''}
                      onChange={(e) =>
                        setEditing((d) => ({ ...d, baseUrl: e.target.value }))
                      }
                      placeholder="如 http://localhost:11434/v1"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs">
                    <span className="text-muted-foreground">
                      API Key 环境变量名（推荐）
                    </span>
                    <Input
                      className="h-8 text-xs"
                      value={editing.apiKeyRef ?? ''}
                      onChange={(e) =>
                        setEditing((d) => ({ ...d, apiKeyRef: e.target.value }))
                      }
                      placeholder="如 LLM_API_KEY"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs">
                    <span className="text-muted-foreground">
                      API Key 明文（不入库选项，也可留空）
                    </span>
                    <Input
                      className="h-8 text-xs"
                      type="password"
                      value={editing.apiKeyInline ?? ''}
                      onChange={(e) =>
                        setEditing((d) => ({
                          ...d,
                          apiKeyInline: e.target.value,
                        }))
                      }
                      placeholder="留空则只用上方环境变量"
                    />
                  </label>
                </div>
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => setEditing(null)}
                  >
                    取消
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    className="h-7 text-xs"
                    disabled={saving || !editing.id || !editing.model}
                    onClick={saveProfile}
                  >
                    {saving ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : null}
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
    </div>
  )
}

export default ModelsSection
