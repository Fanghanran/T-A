import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

// 应用入口：挂载到 #root，启用 React 18 并发特性
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
