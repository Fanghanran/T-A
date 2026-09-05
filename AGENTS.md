# 项目规则（Interview Agent）

> 本文件由 ZCode 每次会话自动加载，与 `.trae/rules/code.md` 保持同步（2026-09-04）。
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
