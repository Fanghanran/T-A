/**
 * agentDefinitions —— 内置智能体注册（模块加载时执行一次）
 *
 * 把原 constants.js 里的 AGENTS 数组迁移到此处，并接入 agentRegistry 的插件化机制。
 * 新增智能体：在此 registerAgent() 一项即可（自动出现在侧边栏 + 路由）。
 *
 * structuredInput=true 的智能体在 ChatInput 中展示结构化输入（技术栈多选）。
 */
import { Search, FileText, Users, Scissors } from 'lucide-react'
import { registerAgent } from './agentRegistry'

// 面试题检索：结构化输入（关键词 + 技术栈多选）
registerAgent({
  id: 'interview-retrieval',
  name: '面试题检索',
  description: '按关键词与技术栈精准检索面试题目，不足时自动兜底知识库',
  icon: Search,
  available: true,
  structuredInput: true,
})

// 简历分析：上传/粘贴简历 → 结构化评估 + JD 匹配 + 出题 + 评分卡
registerAgent({
  id: 'resume-analysis',
  name: '简历分析',
  description: '解析简历并给出优化建议、岗位匹配与针对性面试题',
  icon: FileText,
  available: true,
})

// 模拟面试：技术栈定向多轮问答 + 即时点评 + 结束评分报告
registerAgent({
  id: 'mock-interview',
  name: '模拟面试',
  description: 'AI 模拟真实面试场景对练，结束输出能力评分报告',
  icon: Users,
  available: true,
  structuredInput: true,
})

// 文档处理：文件拖拽上传 + 切片预览 + 入库 + 导出
registerAgent({
  id: 'doc-processor',
  name: '文档处理',
  description: '预处理、切片、整理文档，支持多种格式与自定义策略',
  icon: Scissors,
  available: true,
})
