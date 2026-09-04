import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  test: {
    include: ['tests/**/*.test.{js,jsx}'],
    environment: 'jsdom',
    // globals: 开启后 @testing-library/react 才会注册 afterEach 自动 cleanup，
    // 避免上一用例挂载的组件/异步续体污染下一用例（多元素命中、result.current=null 等）
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/lib/**/*.js', 'src/hooks/**/*.{js,jsx}'],
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
        secure: false,
      },
    },
  },
})
