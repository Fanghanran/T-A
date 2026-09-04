import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

// Vite 配置：启用 React 插件，配置路径别名 @ -> src，并设置 /api 代理到后端服务
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    rollupOptions: {
      output: {
        // vendor 分组：框架层与 Markdown 渲染层各自独立成 chunk，
        // 业务代码改动不再导致大 vendor 包哈希变化，浏览器缓存命中更久
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler|react-router|react-router-dom|@radix-ui)[\\/]/.test(id)) {
            return 'vendor-react'
          }
          if (/[\\/]node_modules[\\/](react-markdown|remark|micromark|mdast|unified|unist|hast|rehype|decode-named-character-reference|character-entities|property-information|space-separated-tokens|comma-separated-tokens|trim-lines|vfile|bail|is-plain-obj|trough|zwitch|longest-streak)[\\/]/.test(id)) {
            return 'vendor-markdown'
          }
          return undefined
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      // 将前端 /api 请求代理到后端服务，避免跨域
      // - 端口 3000：与后端 server/index.js 的 BASE_PORT 默认值一致（npm start 启动的就是 3000）
      //   此前误写为 3001，与后端实际端口不符，前端所有 /api 请求必然 ECONNREFUSED。
      // - 如需自定义后端端口，在 server/ 目录下执行：$env:PORT=XXXX; npm start，并同步修改下面的 target 端口
      // - target 写 127.0.0.1 而非 localhost：避免 Windows 上 localhost 被优先解析到 IPv6 ::1
      //   导致 Node.js net.connect 聚合多地址尝试失败抛 AggregateError[ECONNREFUSED]
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
        secure: false,
      },
    },
  },
})
