import { defineConfig } from 'eslint/config'
import reactHooks from 'eslint-plugin-react-hooks'
import react from 'eslint-plugin-react'

export default defineConfig([
  {
    ignores: ['node_modules/**', 'dist/**', 'coverage/**', 'server/**'],
  },
  {
    files: ['src/**/*.{js,jsx}', 'tests/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: {
        window: 'readonly',
        document: 'readonly',
        fetch: 'readonly',
        localStorage: 'readonly',
        requestAnimationFrame: 'readonly',
        FormData: 'readonly',
        console: 'readonly',
      },
    },
    plugins: { 'react-hooks': reactHooks, react },
    rules: {
      'no-unused-vars': ['warn', { args: 'none' }],
      // 让 no-unused-vars 识别 JSX 中的组件用法（否则所有 <Component /> 都被误报未使用）
      'react/jsx-uses-vars': 'warn',
      // Hook 安全护栏：顺序/条件调用直接报错，依赖缺失提示
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
])
