/**
 * perms —— RBAC 权限点目录（用户模块 v2.3，前后端共享语义）
 *
 * 权限粒度 = 前端界面/菜单 + 对应管理端点。键约定：
 *   - 'chat'          智能体对话（/chat/*）
 *   - 'dashboard'     知识库仪表盘
 *   - 'kb'            文档管理 + 切片阅读器
 *   - 'graph'         知识网络
 *   - 'db'            数据库目录（向量/记忆/会话/基础库浏览）
 *   - 'mgmt.workflows|tools|params|audit|models|users|roles'  系统管理各子页
 *
 * 特殊值 '*'：全部权限（admin 内置角色专用，不出现在可勾选目录中）。
 * 权限存 SQLite accounts.db 的 role_perms 表（role_id, perm）；角色变更即时生效
 * （JWT 只带 role，权限每次请求实时查库）。
 */

/** 可勾选的权限点目录（角色管理页的矩阵行；'*' 不在其中） */
export const PERM_CATALOG = [
  { key: 'chat', label: '智能体对话', group: '核心', desc: '聊天界面与全部智能体' },
  { key: 'dashboard', label: '知识库仪表盘', group: '知识库', desc: '文档/切片统计总览' },
  { key: 'kb', label: '文档管理', group: '知识库', desc: '文档录入、分类、批量管理与切片阅读器' },
  { key: 'graph', label: '知识网络', group: '知识库', desc: '切片语义网络与 LLM Wiki' },
  { key: 'db', label: '数据库目录', group: '数据', desc: '向量 / 记忆 / 会话 / 基础库只读浏览' },
  { key: 'mgmt.workflows', label: '工作流管理', group: '系统管理', desc: '工作流启停与统计' },
  { key: 'mgmt.tools', label: '工具管理', group: '系统管理', desc: '工具启停与统计' },
  { key: 'mgmt.params', label: '参数管理', group: '系统管理', desc: '调优参数 · ES 索引 · 用户令牌' },
  { key: 'mgmt.audit', label: '操作审计', group: '系统管理', desc: '审计记录查询与开关' },
  { key: 'mgmt.models', label: '模型管理', group: '系统管理', desc: '模型 profile 与路由绑定' },
  { key: 'mgmt.users', label: '成员管理', group: '系统管理', desc: '账号增删改查 · 角色 · 禁用/解锁/重置密码' },
  { key: 'mgmt.roles', label: '角色管理', group: '系统管理', desc: '角色与权限矩阵维护' },
  { key: 'mgmt.agents', label: '智能体管理', group: '系统管理', desc: 'Agent Spec 配置：新建/编辑/启停智能体' },
]

export const ALL_PERM_KEYS = PERM_CATALOG.map((p) => p.key)

/** 合法权限集合（含 '*'） */
const VALID = new Set([...ALL_PERM_KEYS, '*'])

/** member 内置角色的默认权限（不含任何系统管理） */
export const DEFAULT_MEMBER_PERMS = ['chat', 'dashboard', 'kb', 'graph']

/** 校验权限键数组（去重保序；非法键抛错） */
export function sanitizePerms(list) {
  if (!Array.isArray(list)) throw new Error('权限集必须为数组')
  const out = []
  for (const raw of list) {
    const key = String(raw ?? '').trim()
    if (!key) continue
    if (!VALID.has(key)) throw new Error(`未知权限：${key}`)
    if (!out.includes(key)) out.push(key)
  }
  return out
}

/** 权限集判定：holds 是否拥有所需权限（'*' 全权；anyOf 满足其一即可） */
export function hasPerm(holds = [], needed = []) {
  const set = new Set(holds)
  if (set.has('*')) return true
  return needed.some((n) => set.has(n))
}
