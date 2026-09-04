# ADR-004：切片写入采用「写完核实 + 启动对账」而非跨集合事务

## 状态

已接受（2026-08-31）

## 背景

知识文档入库分两步写 Milvus 两个集合：`createDocument`（写 `kb_documents`）与 `addChunks`（写 `kb_chunks`），二者非同一事务。历史症状：一篇 PDF 显示 `status=indexed` 但切片数为 0（"文档在、切片没了"的孤儿）。

根因分析：

- `addChunks` 旧逻辑是「`insertChunks` 一被服务端接受，就把文档 `upsertDocument({status:'indexed'})`」——`indexed` 只代表"服务端已接收"，不代表"已落盘"。
- Milvus standalone 写入先进内存 growing 段 + WAL，周期性 flush 到对象存储；容器被硬杀（观测到 `Exited(137)` = OOM/SIGKILL）时，未 flush 的 chunk 段可能随恢复失败一起丢失，而更早 flush 的 doc 行存活 → 不一致。
- `vectorStore.js` 头注释已自陈"双写无事务、孤儿向量"。

## 决策

不引入跨集合分布式事务（Milvus 无此能力，代价高），改用**四层可检测、可自愈**的写入耐久方案：

1. **写完核实（防假 indexed）**：`addChunks` 在 `insertChunks` 后先 `flush([kb_chunks])` 落盘，再用强一致 `countChunksOfDoc` 读回，数量 ≥ 预期才把文档翻 `indexed`；否则抛错、保持 `pending`。空切片直接判错拒绝入库。
2. **幂等重放**：正文始终存于 doc 行，孤儿可用其 content 重新 prepare+addChunks，安全可重入。
3. **启动/健康对账**：`vectorStore.listOrphanDocs()` 扫描 `indexed 且 0 切片` 的文档；`index.js` 启动即告警，`/api/health` 暴露 `orphanDocuments`；提供 `POST /documents/:id/reindex` 与 `POST /orphans/reconcile` 修复。可选 `RECONCILE_ON_BOOT=1` 开机自愈。
4. **降低丢失窗口**：`index.js` SIGTERM/SIGINT 优雅关闭先 flush 再排空；`milvus-compose.yml` 三服务 `restart: unless-stopped`（OOM-137 真因是 Docker 内存不足，需上调而非设小 mem_limit）。

## 后果

- 正面：把"静默数据损坏"降级为"可检测（health/启动对账）、可自动/一键修复（reindex）"；本地单实例下写入语义诚实——不再谎报 `indexed`。
- 残留风险：`insertChunks` 与 `upsertDocument` 之间仍存在极小崩溃窗口（写成功但核实/翻状态前被杀）。该窗口下文档保持 `pending`，被启动对账或手动 reindex 兜底修复，不会丢数据也不会假成功。
- 多实例部署下进程内 `uploadJobs`/内存镜像不共享，对账与限流需外置共享存储。
- 换 embedding 模型/维度需重建 Milvus 集合（与 ADR-003 一致）。

## 备选（未采纳，留待演进）

- **应用级 commit journal**：入库前在本地 `data/` 写一条 `pending-commit` 记录，两集合写成功后清除；进程重启时按 journal 补偿。代价：需实现 journal 读写/清理，收益主要是进一步压缩核实前崩溃窗口——当前由"保持 pending + 启动对账"已等效覆盖，暂不做。
- **先 chunk 后 doc**：调换写入顺序。但两集合最终都要写，任意一步被杀仍可能不一致，且不解决 flush 落盘问题，故不采纳。
