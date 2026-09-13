# 项目规则（Interview Agent）

> 本文件由 ZCode 每次会话自动加载，与 `.trae/rules/code.md` 保持同步（2026-09-13）。
> 架构强制约束（分层/门禁/文件大小上限等）以 `ARCHITECTURE.md` 为准；实施排期以 `docs/ROADMAP.md` 为准；重大技术决策见 `docs/adr/`。本文件只登记协作规则，不重复架构条款。

## 编码规则（与 `.trae/rules/code.md` 同步）

1、之前完成正确的功能，尽量不要修改。 比如当前的 instruction 是完善功能 A 的，那么只需要专注功能 A，不需要修改其他功能（比如功能 B）。
2、生成的注释用中文，并使用 UTF-8 编码。
3、生成的代码有时候会存在中文乱码的情况，所以你在生成中文的时候，需要检查是否有中文乱码，如果有乱码需要修正。
4、如果修改某个函数的实现，先理解之前函数实现的逻辑。然后在原来的基础上，再进行修改（保留之前的函数逻辑，不要移除）
5、你操作的环境是 windows 系统
6、如果用户没有明确说，就不需要编写测试脚本，也不需要写专门的项目说明 md
7、写代码，不考虑 fallback
8、代码中不要有 emoji

## 项目事实与入口（追加项，不修改上述 8 条）

- 提交前门禁：`npm run check:all`（= 构建 + 前端测试 + lint + format + 后端测试 + 分层检查）；改动 `server/lib` 分层结构时另跑 `npm --prefix server run check:layers`。
- 服务端口：前端 5173、后端 3000；本地依赖容器：Milvus（19530/9091）+ Ollama（11434）——后端启动强依赖 Milvus，先起 Docker Desktop 与容器再起后端。
- Windows Git Bash 下 `curl -d '中文'` 内联请求体会被编码成 GBK 乱码发给后端：凡含中文的请求体测试，一律先用 node 写 UTF-8 文件再 `curl --data-binary @file`。
- 运行数据与密钥：`server/.env`（不入库）、`server/data/`（运行时数据，不入库不删除）。
- 降级策略（ADR-009）：禁止静默降级——模型/Embedding/存储不可用时显式报错并提醒，只有「耐久性措施」和「带标注的无增强实现」允许保留。`LLM_STUB=1` 仅用于验证提醒链路。
- Node 版本硬约束：**必须 Node 24** 跑后端（better-sqlite3 按 Node 24 ABI 编译；Node 22 报 ERR_DLOPEN_FAILED，症状隐蔽：服务能起、检索正常，但会话接口全报 SESSION_DB_UNAVAILABLE）。换 Node 后需 `npm rebuild better-sqlite3`。
- 认证（v2.3）：`AUTH_MODE` = disabled（单用户 local，零配置）/ jwt（登录 + RBAC + owner 数据隔离，默认登录 admin）/ user-token / token。management 路由主体字段是 `req.adminUserId/adminRole`；数据路由是 `req.principal.userId`——两条链路不要混用。
- 存储（v3）：`STORAGE_MODE=v3` = 文件原件（事实源）+ SQLite 锚点层 + Milvus 瘦向量；默认 v2（Milvus 全量 + 内存镜像）。切片 id 两代不同（v2 带随机后缀、v3 为 chk_{docId}_{idx}），wiki 提及边按 docId|idx 桥接。会话库真库由 `SESSIONS_DB_FILE` 指定（data/sessions/sessions_clean.db）。
- ES 第三通道：`ES_ENABLED=on` 时 BM25 关键词召回并入混合排序（需 docker 起.elasticsearch）；全量回填走 POST /api/management/es/sync。
- 数据路由（/api/knowledge、/api/chat 等）与管理路由（/api/management）的主体字段与守卫**不是一套**：前者 M5a 守卫挂 req.principal，后者 adminAuth 挂 req.adminUserId/adminRole——新端点必须按所属挂载点取主体，写死 'local' 或漏传 ownerId 都会被 Fail-Fast 守卫拦截。
- 检索评测：`server/test/retrieval.golden.json`（22 用例）+ `node --env-file-if-exists=.env scripts/eval-retrieval.mjs`（hit@3/MRR，可 --contract 查意图改写契约）。改检索/改写/排序前后各跑一次防退化。
- 语音输入：`STT_BASE_URL`（OpenAI 兼容转写端点）未配置时 /api/stt 返回 501，前端不显示麦克风。
- 检索排序链路（改顺序前必读）：多 query 最高分融合（**不是累加**——累加在 304 片语料实测 hit@3 从 100% 崩到 18%）→ 2-gram 字面加权 → 否定排除词降权 → 近重复折叠 → 单文档配额。顺序有依赖（降权必须在 2-gram 之后），改动前跑评测。
