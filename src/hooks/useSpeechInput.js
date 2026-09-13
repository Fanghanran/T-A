import * as React from 'react'
import { request } from '@/lib/api'
import { child } from '@/lib/logger'

const log = child('speech')

/**
 * useSpeechInput —— 语音输入（录音 → 后端转写 → 文本），M：语音识别
 *
 * 交互：点击麦克风开始录音 → 再次点击停止并转写 → onResult(text) 回填输入框。
 * 状态机：idle → recording → transcribing → idle；错误停在 idle 并带 message。
 * 依赖：浏览器 MediaRecorder + getUserMedia（HTTPS 或 localhost 下可用），
 *       转写由后端 /api/stt 转发至已配置的 STT 服务（未配置时接口 501，这里转为提示）。
 */
export function useSpeechInput({ onResult } = {}) {
  const [status, setStatus] = React.useState('idle') // idle | recording | transcribing
  const [error, setError] = React.useState('')
  const [enabled, setEnabled] = React.useState(null) // null = 探测中
  const recorderRef = React.useRef(null)
  const chunksRef = React.useRef([])
  const streamRef = React.useRef(null)

  // 探测服务端是否配置了语音识别（决定麦克风按钮显隐）
  React.useEffect(() => {
    let alive = true
    request('/api/stt')
      .then((r) => {
        if (alive) setEnabled(Boolean(r?.enabled))
      })
      .catch(() => {
        if (alive) setEnabled(false)
      })
    return () => {
      alive = false
    }
  }, [])

  const cleanup = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    recorderRef.current = null
    chunksRef.current = []
  }

  const start = React.useCallback(async () => {
    setError('')
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('当前浏览器不支持录音')
        return
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((m) =>
        MediaRecorder.isTypeSupported?.(m),
      )
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
      chunksRef.current = []
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      recorder.onstop = async () => {
        cleanup()
        setStatus('transcribing')
        try {
          const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
          const form = new FormData()
          form.append('file', blob, `speech.${(recorder.mimeType || 'audio/webm').includes('mp4') ? 'mp4' : 'webm'}`)
          const r = await request('/api/stt', { method: 'POST', body: form })
          const text = String(r?.text ?? '').trim()
          if (!text) {
            setError('没有识别到语音内容')
          } else {
            onResult?.(text)
          }
        } catch (err) {
          log.error('[speech] 转写失败', err)
          setError(err?.message || '语音转写失败')
        } finally {
          setStatus('idle')
        }
      }
      recorder.start()
      recorderRef.current = recorder
      setStatus('recording')
    } catch (err) {
      cleanup()
      setError(err?.name === 'NotAllowedError' ? '麦克风权限被拒绝' : `录音启动失败：${err.message}`)
      setStatus('idle')
    }
  }, [onResult])

  const stop = React.useCallback(() => {
    recorderRef.current?.stop() // onstop 内转写
  }, [])

  const toggle = React.useCallback(() => {
    if (status === 'recording') stop()
    else if (status === 'idle') start()
  }, [status, start, stop])

  return { status, error, enabled, toggle, setError }
}

export default useSpeechInput
