/**
 * env.js —— 保证 server/.env 无论以何种方式启动后端都会被加载。
 *
 * 背景：
 *   package.json 的 start 脚本是 `node --env-file-if-exists=.env index.js`，
 *   依赖 Node 20.6+ 的原生 --env-file 开关来注入 .env。
 *   但用户经常直接 `node index.js` 或通过 `$env:PORT=3001; node index.js` 启动，
 *   此时 .env 文件不会被读入，LLM_API_KEY / LLM_BASE_URL 等变量全为空 → 一直降级 stub，
 *   导致用户以为"我的模型没参与回答"。
 *
 * 解决方案：
 *   在 index.js 的**第一行** `import './env.js'`，这里用 dotenv + 绝对路径显式加载
 *   同目录下的 server/.env，和 Node 原生 --env-file 开关完全等价，而且不冲突（
 *   环境变量已经被 shell 注入时，dotenv 不会覆盖 process.env 中已有的值）。
 */
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import dotenv from 'dotenv'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const envPath = resolve(__dirname, '.env')

// override: false 是 dotenv 的默认行为：process.env 已经存在的同名 key 不会被 .env 覆盖。
// 这正是我们想要的（例如 shell 显式传的 PORT / LLM_API_KEY 优先级高于 .env）。
dotenv.config({ path: envPath, override: false })
