import * as React from 'react'
import { useNavigate, useLocation, useSearchParams } from 'react-router-dom'
import { Bot, Loader2, AlertCircle, LogIn, UserPlus } from 'lucide-react'
import { setUserToken } from '@/lib/api'
import { fetchAuthMe, loginWithPassword, registerAccount } from '@/lib/authClient'
import { useAuth, sanitizeRedirect } from '@/hooks/useAuth'

/**
 * AuthPage —— 登录 / 注册 / OAuth 回调页（v3 视觉重设计：复古未来 × 技术终端）
 *
 * 设计定调：暗夜蓝黑底 + 产品靛蓝 + 荧光青强调；JetBrains Mono 承担终端叙事与表单标签。
 * 记忆点：左侧「系统引导终端」逐行亮起本机 RAG 流水线的真实启动序列，READY 后解锁表单。
 * 全部动效仅在 prefers-reduced-motion: no-preference 下启用；业务逻辑与 v2 完全一致。
 *
 * 路由：
 *   /auth            登录 + 注册双 Tab（注册 Tab 由后端 AUTH_REGISTRATION 门控）
 *   /auth/callback   OAuth 回调落地：解析 location.hash 的 token/error 并落地
 */

/* ---------- 本页专属样式：终端氛围 / 网格地平线 / 编排入场（scoped，不污染全局） ---------- */
const AUTH_STYLE = `
  .auth-root { font-feature-settings: 'rlig' 1, 'calt' 1; }
  .auth-mono { font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }

  /* 氛围层：两团靛蓝径向光晕 + 底部网格地平线 + 噪点颗粒 */
  .auth-atmo { position: fixed; inset: 0; pointer-events: none; }
  .auth-atmo::before {
    content: ""; position: absolute; inset: 0;
    background:
      radial-gradient(52rem 36rem at 8% -12%, rgba(99,102,241,.16), transparent 62%),
      radial-gradient(44rem 34rem at 96% 4%, rgba(52,224,200,.07), transparent 58%),
      radial-gradient(60rem 44rem at 50% 118%, rgba(99,102,241,.10), transparent 60%);
  }
  .auth-atmo::after {
    content: ""; position: absolute; inset: 0; opacity: .05; mix-blend-mode: overlay;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.8'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
  }
  .auth-grid {
    position: fixed; inset: auto 0 0 0; height: 38vh; pointer-events: none; opacity: .5;
    background-image:
      linear-gradient(rgba(129,140,248,.07) 1px, transparent 1px),
      linear-gradient(90deg, rgba(129,140,248,.07) 1px, transparent 1px);
    background-size: 44px 44px;
    -webkit-mask-image: linear-gradient(to top, rgba(0,0,0,.9), transparent);
    mask-image: linear-gradient(to top, rgba(0,0,0,.9), transparent);
  }

  /* 编排入场：终端行 90ms 错峰，表单卡 240ms 后整体上浮 */
  @media (prefers-reduced-motion: no-preference) {
    .auth-reveal { opacity: 0; transform: translateY(14px); animation: auth-in .5s cubic-bezier(.16,1,.3,1) both; }
    .auth-reveal:nth-child(1) { animation-delay: .12s }
    .auth-reveal:nth-child(2) { animation-delay: .21s }
    .auth-reveal:nth-child(3) { animation-delay: .30s }
    .auth-reveal:nth-child(4) { animation-delay: .39s }
    .auth-reveal:nth-child(5) { animation-delay: .48s }
    .auth-reveal:nth-child(6) { animation-delay: .57s }
    .auth-reveal:nth-child(7) { animation-delay: .66s }
    .auth-card-in { opacity: 0; transform: translateY(20px); animation: auth-in .6s cubic-bezier(.16,1,.3,1) .28s both; }
    .auth-caret { animation: auth-blink 1.05s steps(1) infinite; }
    .auth-scan { animation: auth-scan 7s linear infinite; }
  }
  @media (prefers-reduced-motion: reduce) {
    .auth-reveal, .auth-card-in { opacity: 1 !important; transform: none !important; animation: none !important; }
    .auth-caret { animation: none; }
  }
  @keyframes auth-in { to { opacity: 1; transform: none; } }
  @keyframes auth-blink { 50% { opacity: 0; } }
  @keyframes auth-scan { from { transform: translateY(-100%);} to { transform: translateY(2200%);} }

  /* 输入控件：暗玻璃底 + 聚焦荧光青描边（覆盖 shadcn Input 默认观感） */
  .auth-input {
    width: 100%; height: 44px; padding: 0 14px; border-radius: 10px;
    background: rgba(255,255,255,.035);
    border: 1px solid rgba(148,163,184,.22);
    color: #e8ecf6; font-size: 14px; letter-spacing: .01em;
    transition: border-color .18s ease-out, box-shadow .18s ease-out, background .18s ease-out;
  }
  .auth-input::placeholder { color: rgba(203,213,225,.34); }
  .auth-input:hover { border-color: rgba(148,163,184,.38); }
  .auth-input:focus { outline: none; background: rgba(255,255,255,.055); border-color: rgba(52,224,200,.65); box-shadow: 0 0 0 3px rgba(52,224,200,.14); }
  .auth-label { font-size: 11px; letter-spacing: .14em; color: rgba(203,213,225,.62); }

  /* 主按钮：靛蓝实心，hover 提亮并微移 */
  .auth-submit {
    width: 100%; height: 46px; border-radius: 10px; border: none; cursor: pointer;
    display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    background: linear-gradient(180deg, hsl(234 89% 74%), hsl(238 76% 66%));
    color: #0b0e14; font-weight: 700; font-size: 14px; letter-spacing: .06em;
    box-shadow: 0 8px 24px -8px rgba(99,102,241,.55), inset 0 1px 0 rgba(255,255,255,.25);
    transition: filter .16s ease-out, transform .16s ease-out, box-shadow .16s ease-out;
  }
  .auth-submit:hover:not(:disabled) { filter: brightness(1.1); transform: translateY(-1px); }
  .auth-submit:active:not(:disabled) { transform: translateY(0); filter: brightness(.96); }
  .auth-submit:disabled { opacity: .45; cursor: not-allowed; box-shadow: none; }
  .auth-submit:focus-visible { outline: 2px solid #34e0c8; outline-offset: 2px; }

  /* Tab：终端下划线式 */
  .auth-tab {
    position: relative; background: none; border: none; cursor: pointer; padding: 10px 2px;
    font-size: 12px; letter-spacing: .22em; color: rgba(203,213,225,.5);
    transition: color .18s ease-out;
  }
  .auth-tab:hover { color: rgba(232,236,246,.85); }
  .auth-tab:focus-visible { outline: 2px solid #34e0c8; outline-offset: 2px; border-radius: 4px; }
  .auth-tab[data-active='true'] { color: #e8ecf6; }
  .auth-tab[data-active='true']::after {
    content: ""; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px;
    background: #34e0c8; box-shadow: 0 0 12px rgba(52,224,200,.8);
  }
`

/* ---------- 系统引导终端：把本机 RAG 启动序列做成品牌叙事 ---------- */
const BOOT_LINES = [
  { cmd: true, text: '$ interview-agent --boot' },
  { ok: 'milvus', text: 'localhost:19530 · 知识向量就绪' },
  { ok: 'ollama', text: 'qwen3:14b · bge-m3 (1024d)' },
  { ok: 'elasticsearch', text: 'bm25 检索通道在线' },
  { ok: 'sqlite', text: '会话 / 账号 / 标注 落盘完成' },
  { ok: 'rbac', text: '角色与权限矩阵已加载' },
]

function BootTerminal() {
  return (
    <div className="auth-reveal relative w-full max-w-xl overflow-hidden rounded-xl border border-indigo-200/10 bg-[#0d1119]/85 shadow-[0_24px_64px_-24px_rgba(0,0,0,.8)] backdrop-blur-sm">
      {/* 标题栏：终端圆点 + 路径 */}
      <div className="auth-mono flex items-center gap-2 border-b border-white/[0.06] px-4 py-2.5 text-[11px] text-slate-500">
        <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]/80" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]/80" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]/80" />
        <span className="ml-2 tracking-[0.18em]">rag://boot — local pipeline</span>
      </div>
      {/* 扫描线：极淡的青色光带缓慢下移（reduce 时静止） */}
      <div className="auth-scan pointer-events-none absolute inset-x-0 top-0 h-10 bg-gradient-to-b from-transparent via-cyan-300/[0.045] to-transparent" />
      <div className="auth-mono space-y-2 px-5 py-4 text-[12.5px] leading-relaxed">
        {BOOT_LINES.map((l, i) => (
          <p key={l.text} className="auth-reveal flex gap-3 text-slate-300" style={{ animationDelay: `${0.3 + i * 0.18}s` }}>
            {l.cmd ? (
              <span className="text-slate-500">{l.text}</span>
            ) : (
              <>
                <span className="w-4 shrink-0 text-[#34e0c8]">✓</span>
                <span className="w-28 shrink-0 text-indigo-300">{l.ok}</span>
                <span className="text-slate-400">{l.text}</span>
              </>
            )}
          </p>
        ))}
        {/* READY 行 + 闪烁光标 */}
        <p className="auth-reveal flex items-center gap-3 pt-1 text-[#34e0c8]" style={{ animationDelay: '1.42s' }}>
          <span className="tracking-[0.3em]">READY</span>
          <span className="auth-caret inline-block h-4 w-2 bg-[#34e0c8]/90" />
        </p>
      </div>
    </div>
  )
}

/** OAuth 回调落地视图：令牌写入 → 刷新全局身份 → 回跳（外部往返后 redirect 参数丢失，回首页） */
function OAuthCallback() {
  const navigate = useNavigate()
  const { refresh } = useAuth()
  const [error, setError] = React.useState('')
  React.useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''))
    const token = hash.get('token')
    const err = hash.get('error')
    if (token) {
      setUserToken(token)
      refresh().finally(() => navigate('/', { replace: true }))
      return
    }
    setError(err || 'OAuth 回调缺少令牌')
  }, [navigate, refresh])
  return (
    <div className="flex flex-col items-center gap-4 text-center">
      <AlertCircle className="h-8 w-8 text-red-400" />
      <p className="auth-mono text-sm text-slate-400">{error || '正在处理登录…'}</p>
      <button type="button" onClick={() => navigate('/auth', { replace: true })} className="auth-mono text-xs tracking-[0.14em] text-indigo-300 underline-offset-4 hover:underline">
        ← 返回登录
      </button>
    </div>
  )
}

/** 登录/注册主视图（登录成功后按 ?redirect= 原样回跳受保护页面） */
function AuthForm() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { refresh } = useAuth()
  const [tab, setTab] = React.useState('login')
  const [userId, setUserId] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [label, setLabel] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const [me, setMe] = React.useState(null)

  React.useEffect(() => {
    fetchAuthMe().then(setMe).catch(() => setMe(null))
  }, [])

  const canRegister = me?.registrationEnabled !== false
  const oauth = me?.oauth
  const redirectTarget = sanitizeRedirect(searchParams.get('redirect'))

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      if (tab === 'register') {
        await registerAccount(userId.trim(), password, label.trim())
        // 注册成功自动登录
      }
      const r = await loginWithPassword(userId.trim(), password)
      setUserToken(r.token)
      // 先同步全局身份再跳转：AuthGate 依赖 status 放行，直接导航会被拦回 /auth
      await refresh()
      navigate(redirectTarget, { replace: true })
    } catch (err) {
      setError(err?.message || '操作失败')
    } finally {
      setBusy(false)
    }
  }

  const startOAuth = async () => {
    setError('')
    try {
      const res = await fetch('/api/auth/oauth/start')
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data?.url) throw new Error(data?.message || 'OAuth 未启用')
      window.location.href = data.url
    } catch (err) {
      setError(err?.message || 'OAuth 跳转失败')
    }
  }

  return (
    <div className="auth-card-in w-full max-w-sm">
      <div className="relative overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.03] p-7 shadow-[0_24px_64px_-24px_rgba(0,0,0,.8)] backdrop-blur-md sm:p-8">
        {/* 卡片顶部发丝高光 */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/25 to-transparent" />

        {/* Tab：终端下划线式 */}
        <div className="auth-mono flex gap-6 border-b border-white/[0.08]" role="tablist">
          {[
            { key: 'login', label: '登录' },
            ...(canRegister ? [{ key: 'register', label: '注册' }] : []),
          ].map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              data-active={tab === t.key}
              className="auth-tab"
              onClick={() => {
                setTab(t.key)
                setError('')
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        <form onSubmit={submit} className="mt-6 space-y-4">
          <div>
            <label className="auth-mono auth-label mb-2 block uppercase" htmlFor="auth-userid">
              用户 ID / userid
            </label>
            <input
              id="auth-userid"
              className="auth-input auth-mono"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              placeholder="admin"
              autoComplete="username"
              required
            />
          </div>
          <div>
            <label className="auth-mono auth-label mb-2 block uppercase" htmlFor="auth-password">
              密码{tab === 'register' && ' / 6~16 位'}
            </label>
            <input
              id="auth-password"
              className="auth-input auth-mono"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete={tab === 'register' ? 'new-password' : 'current-password'}
              maxLength={tab === 'register' ? 16 : undefined}
              required
            />
          </div>
          {tab === 'register' && (
            <div>
              <label className="auth-mono auth-label mb-2 block uppercase" htmlFor="auth-label">
                备注 / 可选
              </label>
              <input
                id="auth-label"
                className="auth-input"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="给自己起个名字"
              />
            </div>
          )}

          {/* 错误态：终端式 [auth:error] 前缀 + 左侧红条 */}
          {error && (
            <p className="auth-mono flex items-start gap-2 rounded-md border-l-2 border-red-400/70 bg-red-400/[0.06] px-3 py-2 text-xs leading-relaxed text-red-300" role="alert">
              <span className="shrink-0 text-red-400/70">[auth:error]</span>
              {error}
            </p>
          )}

          <button type="submit" className="auth-submit auth-mono" disabled={busy || !userId.trim() || !password}>
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : tab === 'register' ? (
              <UserPlus className="h-4 w-4" />
            ) : (
              <LogIn className="h-4 w-4" />
            )}
            {tab === 'register' ? '注册并登录' : '进入系统'}
          </button>
        </form>

        {oauth?.enabled && (
          <>
            <div className="auth-mono my-5 flex items-center gap-3 text-[10px] tracking-[0.3em] text-slate-500">
              <span className="h-px flex-1 bg-white/[0.08]" />
              或
              <span className="h-px flex-1 bg-white/[0.08]" />
            </div>
            <button
              type="button"
              onClick={startOAuth}
              className="auth-mono h-11 w-full rounded-[10px] border border-indigo-300/25 bg-indigo-400/[0.06] text-xs tracking-[0.14em] text-indigo-200 transition-colors hover:border-indigo-300/50 hover:bg-indigo-400/[0.12] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#34e0c8]"
            >
              使用 {oauth.label} 账号登录 →
            </button>
          </>
        )}
      </div>

      {/* 数据主权声明：本产品的核心卖点，值得一行终端字 */}
      <p className="auth-mono mt-4 text-center text-[10.5px] tracking-[0.12em] text-slate-500">
        LOCAL-ONLY · 数据不出本机 · 按用户隔离存储
      </p>
    </div>
  )
}

export function AuthPage() {
  const location = useLocation()
  const isCallback = location.pathname.startsWith('/auth/callback')
  return (
    <div className="auth-root relative flex h-dvh w-full flex-col overflow-hidden bg-[#0b0e14] text-slate-200">
      <style>{AUTH_STYLE}</style>

      {/* 氛围层：光晕 / 噪点 / 网格地平线 */}
      <div className="auth-atmo" aria-hidden />
      <div className="auth-grid" aria-hidden />

      {/* 主体：非对称双栏 —— 左品牌叙事（lg+ 显示终端）右表单 */}
      <div className="relative z-10 mx-auto grid w-full max-w-6xl flex-1 items-center gap-12 px-6 py-10 lg:grid-cols-[1.15fr_1fr] lg:gap-16">
        {/* 左栏：品牌 + 引导终端 */}
        <div className="hidden flex-col gap-8 lg:flex">
          <div className="auth-reveal flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-indigo-300/30 bg-indigo-400/10 shadow-[0_0_24px_-6px_rgba(99,102,241,.6)]">
              <Bot className="h-5 w-5 text-indigo-300" />
            </div>
            <span className="auth-mono text-[11px] tracking-[0.4em] text-slate-500">v2.3 · LOCAL RAG</span>
          </div>

          <h1 className="auth-reveal auth-mono text-5xl font-bold leading-[1.05] tracking-tight text-slate-100 xl:text-6xl" style={{ animationDelay: '.06s' }}>
            Interview
            <br />
            <span className="text-indigo-300">Agent_</span>
          </h1>

          <p className="auth-reveal max-w-md text-[15px] leading-relaxed text-slate-400" style={{ animationDelay: '.16s' }}>
            私有知识库 × 面试题库的本地检索增强助手。
            向量、关键词与重排三路召回在你的机器上完成——登录后即刻开始。
          </p>

          <BootTerminal />
        </div>

        {/* 右栏：表单（移动端顶部压缩品牌行） */}
        <div className="flex flex-col items-center gap-7">
          {/* 移动端品牌行（lg 隐藏） */}
          <div className="auth-reveal flex items-center gap-3 lg:hidden">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-indigo-300/30 bg-indigo-400/10">
              <Bot className="h-5 w-5 text-indigo-300" />
            </div>
            <div>
              <p className="auth-mono text-base font-bold tracking-tight text-slate-100">Interview Agent</p>
              <p className="auth-mono text-[10px] tracking-[0.3em] text-slate-500">LOCAL RAG · v2.3</p>
            </div>
          </div>

          {isCallback ? <OAuthCallback /> : <AuthForm />}
        </div>
      </div>
    </div>
  )
}

export default AuthPage
