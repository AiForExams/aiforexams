import { useState, useRef, useEffect } from 'react'

import styles from './App.module.css'

const MODELS = [
  { id: 'claude', label: 'CLAUDE', enabled: true },
  { id: 'gemini', label: 'GEMINI', enabled: true },
  { id: 'deepseek', label: 'DEEPSEEK', enabled: true },
  { id: 'chatgpt', label: 'ChatGPT', enabled: true },
] as const

type Message = {
  role: 'user' | 'model'
  modelId?: string
  text: string
  imageUrl?: string
  status?: 'waiting' | 'done' | 'error'
}

export function App() {
  const [messages, setMessages] = useState<Message[]>([])
  const [pending, setPending] = useState(false)
  const [selectedModels, setSelectedModels] = useState<Record<string, boolean>>(
    Object.fromEntries(MODELS.map((m) => [m.id, true]))
  )
  const [text, setText] = useState('')
  const [image, setImage] = useState<string | null>(null)

  const fileRef = useRef<HTMLInputElement>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const formRef = useRef<HTMLFormElement>(null)

  useEffect(() => {
    logRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [messages])

  function toggleModel(id: string) {
    setSelectedModels((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const url = URL.createObjectURL(file)
    setImage(url)
  }

  async function send() {
    const trimmed = text.trim()
    if (!trimmed && !image) return

    setPending(true)
    const userMsg: Message = {
      role: 'user',
      text: trimmed || '📷 фото',
      imageUrl: image ?? undefined,
    }
    setMessages((prev) => [...prev, userMsg])

    setText('')
    setImage(null)
    if (fileRef.current) fileRef.current.value = ''

    try {
      const body: Record<string, unknown> = { text: trimmed || '', image }
      if (image) body.image = image
      if (selectedModels) body.models = Object.keys(selectedModels).filter((k) => selectedModels[k])

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }))
        throw new Error(err.error ?? 'ошибка запроса')
      }

      const data = (await res.json()) as { responses: { model: string; text: string }[] }
      const respMessages: Message[] = data.responses.map((r) => ({
        role: 'model',
        modelId: r.model,
        text: r.text,
        status: 'done',
      }))
      setMessages((prev) => [...prev, ...respMessages])
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'неизвестная ошибка'
      const fallback: Message[] = MODELS.map((m) => ({
        role: 'model',
        modelId: m.id,
        text: msg,
        status: 'error',
      }))
      setMessages((prev) => [...prev, ...fallback])
    } finally {
      setPending(false)
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    send()
  }

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <h1>ИИ-чат для тестов</h1>
        <p className={styles.sub}>загрузи фото — получи ответы от 여러 ИИ</p>
      </header>

      <section className={styles.models}>
        {MODELS.map((m) => (
          <label key={m.id} className={styles.model}>
            <input
              type="checkbox"
              checked={selectedModels[m.id]}
              onChange={() => toggleModel(m.id)}
            />
            <span>{m.label}</span>
          </label>
        ))}
      </section>

      <section className={styles.log} ref={logRef}>
        {messages.map((msg, i) => (
          <div key={i} className={`${styles.msg} ${msg.role === 'user' ? styles.user : styles.model}`}>
            {msg.role === 'user' && msg.imageUrl && (
              <img className={styles.userImage} src={msg.imageUrl} alt="фото" />
            )}
            {msg.role === 'user' && <div className={styles.msgText}>{msg.text}</div>}
            {msg.role === 'model' && (
              <div className={styles.modelHeader}>
                <span>{msg.modelId ? msg.modelId.toUpperCase() : '?'}</span>
                {msg.status === 'error' && <span className={styles.err}>ошибка</span>}
                {msg.status === 'waiting' && <span className={styles.wait}>ждать...</span>}
              </div>
            )}
            {msg.role === 'model' && (
              <div className={styles.msgText}>{msg.text || '—'}</div>
            )}
          </div>
        ))}
        {pending && (
          <div className={styles.msg + ' ' + styles.model}>
            <div className={styles.modelHeader}><span>ЖДЁМ</span></div>
            <div className={styles.wait}>загружаем ответы...</div>
          </div>
        )}
      </section>

      <form className={styles.form} onSubmit={handleSubmit} ref={formRef}>
        <input
          className={styles.input}
          type="text"
          placeholder="вопрос или оставить пустым для фото"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <input
          className={styles.fileInput}
          type="file"
          accept="image/*"
          capture="environment"
          ref={fileRef}
          onChange={handleFileChange}
        />
        <button type="submit" className={styles.send} disabled={pending}>
          {pending ? 'отправка...' : 'отправить'}
        </button>
      </form>
    </div>
  )
}
