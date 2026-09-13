import { Router } from 'express'
import * as store from '../lib/vectorStore.js'
import * as questionBank from '../lib/questionBank.js'
import * as sessionStore from '../lib/sessionStore.js'
import { llmMode, embeddingMode } from '../lib/config.js'

/**
 * routes/health —— 服务自描述与健康检查
 *
 * 端点：
 *  - GET /             服务信息（名称/模式/统计/端点清单）
 *  - GET /api/health   健康检查（各存储统计 + LLM/Embedding 模式）
 *
 * 依赖：vectorStore / questionBank / sessionStore（只读统计）、config（模式展示）。
 * 纯只读，无副作用，可任意频次调用。
 */

export const healthRouter = Router()

// ---------- 根路径：服务自描述 ----------
healthRouter.get('/', (_req, res) => {
  res.json({
    name: 'Interview-Agent RAG',
    version: '0.1.0',
    llm: llmMode,
    embedding: embeddingMode,
    ...store.stats(),
    endpoints: [
      'GET /api/health',
      'GET /api/metrics                        运行指标快照（检索延迟 / LLM 耗时 / HyDE 触发率 / 缓存命中 / HTTP 计数）',
      'GET  /api/sessions                     会话列表（?agentName= 过滤）',
      'POST /api/sessions                     创建会话（{agentName, title?}）',
      'GET  /api/sessions/:id                 会话详情 + 历史消息',
      'PATCH /api/sessions/:id                重命名（{title}）',
      'DELETE /api/sessions/:id               删除会话',
      'POST /api/search/query                 统一知识检索（面试题 + 知识库向量，scope 切换）',
      'POST /api/knowledge/documents          上传 md/txt/html/csv/json/yaml… → 切片向量化入库（支持 chunkStrategy/delimiter/maxChars）',
      'POST /api/knowledge/preview-chunks     预览切片（不入库，零副作用；{text,strategy,delimiter?,maxChars?}）',
      'POST /api/knowledge/documents/manual   手动录入单条知识（title + content + category + tags + source）',
      'GET  /api/knowledge/documents          列表（category/tag/q 过滤 + sort + page）',
      'GET  /api/knowledge/documents/:id      详情（含正文 content）',
      'PATCH /api/knowledge/documents/:id     编辑文档（元数据 或 正文重切片重嵌入）',
      'DELETE /api/knowledge/documents/:id    删除文档 + 同步移除向量',
      'GET  /api/knowledge/documents/:id/chunks  切片列表（含 displayTitle 独立切片标题）',
      'POST /api/knowledge/documents/batch    批量操作（delete/setCategory/addTags/removeTag）',
      'GET  /api/knowledge/categories         分类聚合 {name,count}',
      'GET  /api/knowledge/tags               标签聚合 {name,count}',
      'POST /api/knowledge/search             纯语义检索（返回片段 + 相似度）',
      'POST /api/knowledge/ask                RAG 流式回答（AI SDK data-stream）',
      'GET  /api/interview/stats              面试题库统计',
      'GET  /api/interview/questions          面试题库列表',
      'POST /api/interview/search             结构化面试题检索（关键词 + 技术栈加权）',
      'POST /api/chat                         通用对话流式（body 可选 sessionId，响应头 x-session-id）',
    ],
    sessions: sessionStore.stats(),
  })
})

// ---------- 健康检查 ----------
healthRouter.get('/api/health', (_req, res) => {
  const orphans = store.listOrphanDocs()
  res.json({
    ok: orphans.length === 0,
    llm: llmMode,
    embedding: embeddingMode,
    ...store.stats(), // { documents, chunks }
    knowledgeByCategory: store.statsByCategoryAll(), // 系统级统计（无 owner 维度）
    // 一致性自检：status=indexed 但 0 切片的孤儿文档（可经 /api/knowledge/orphans 查、reindex 修复）
    orphanDocuments: orphans.length,
    orphans: orphans.map((o) => ({ id: o.id, title: o.title })),
    questions: questionBank.stats('*').total, // 系统自检：全库聚合口径
    byCategory: questionBank.stats('*').byCategory,
    sessions: sessionStore.stats(), // { totalSessions, totalMessages }
  })
})
