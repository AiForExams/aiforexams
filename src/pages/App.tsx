import { useEffect, useRef, useState } from 'react'

import styles from './App.module.css'

const MODELS = [
  { id: 'claude', label: 'CLAUDE' },
  { id: 'gemini', label: 'GEMINI' },
  { id: 'deepseek', label: 'DEEPSEEK' },
  { id: 'chatgpt', label: 'ChatGPT' },
] as const

type ModelId = (typeof MODELS)[number]['id']

interface Reply {
  id: string
  label: string
  text: string
  ms?: number
  error?: boolean
}

type Message =
  | { kind: 'user'; text: string; image?: string }
  | { kind: 'ai'; label: string; text: string; ms?: number; error?: boolean }

const MAX_SIDE = 1400
const JPEG_QUALITY = 0.82

/** Сжимает фото в data-URL: так его понимает и сервер, и OpenRouter. */
async function toDataUrl(file: File): Promise<string> {
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas недоступен')
    ctx.drawImage(bitmap, 0, 0, width, height)
    if (typeof bitmap.close === 'function') bitmap.close()

    return canvas.toDataURL('image/jpeg', JPEG_QUALITY)
  } catch {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(new Error('не удалось прочитать фото'))
      reader.readAsDataURL(file)
    })
  }
}

export function App() {
  const [messages, setMessages] = useState<Message[]>([])
  const [pending, setPending] = useState(false)
  const [enabled, setEnabled] = useState<Record<ModelId, boolean>>({
    claude: true,
    gemini: true,
    deepseek: true,
    chatgpt: true,
  })
  const [text, setText] = useState('')

  const fileRef = useRef<HTMLInputElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, pending])

  function toggleModel(id: ModelId) {
    setEnabled((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  async function ask(question: string, photo?: string) {
    const trimmed = question.trim()
    if (!trimmed && !photo) return
    if (pending) return

    const chosen = MODELS.filter((m) => enabled[m.id]).map((m) => m.id)
    if (!chosen.length) {
      setMessages((prev) => [
        ...prev,
        { kind: 'ai', label: 'ВНИМАНИЕ', text: 'Включи хотя бы одну модель.', error: true },
      ])
      return
    }

    setPending(true)
    setText('')
    setMessages((prev) => [...prev, { kind: 'user', text: trimmed, image: photo }])

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: trimmed, image: photo ?? '', models: chosen }),
      })

      const data = (await response.json().catch(() => null)) as
        | { responses?: Reply[]; error?: string }
        | null

      if (!response.ok) {
        throw new Error(data?.error ?? `сервер ответил ${response.status}`)
      }

      const replies = data?.responses ?? []
      if (!replies.length) throw new Error('сервер вернул пустой список ответов')

      setMessages((prev) => [
        ...prev,
        ...replies.map<Message>((reply) => ({
          kind: 'ai',
          label: reply.label ?? reply.id.toUpperCase(),
          text: reply.text,
          ms: reply.ms,
          error: reply.error,
        })),
      ])
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'неизвестная ошибка'
      setMessages((prev) => [...prev, { kind: 'ai', label: 'ОШИБКА', text: reason, error: true }])
    } finally {
      setPending(false)
    }
  }

  async function handlePhoto(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return

    try {
      const dataUrl = await toDataUrl(file)
      await ask(text, dataUrl)
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'не удалось обработать фото'
      setMessages((prev) => [...prev, { kind: 'ai', label: 'ОШИБКА', text: reason, error: true }])
    }
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    void ask(text)
  }

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <h1 className={styles.title}>Решаем тест</h1>
        <p className={styles.sub}>Кинь фото задания — четыре ИИ ответят сразу</p>
      </header>

      <div className={styles.models}>
        {MODELS.map((model) => (
          <button
            key={model.id}
            type="button"
            onClick={() => toggleModel(model.id)}
            className={`${styles.chip} ${enabled[model.id] ? styles.chipOn : ''}`}
            aria-pressed={enabled[model.id]}
          >
            {model.label}
          </button>
        ))}
      </div>

      <main className={styles.log}>
        {messages.length === 0 && (
          <p className={styles.empty}>
            Нажми на камеру и сфотографируй вопрос. Ответы придут от CLAUDE, GEMINI, DEEPSEEK и
            ChatGPT.
          </p>
        )}

        {messages.map((message, index) =>
          message.kind === 'user' ? (
            <div key={index} className={styles.userMsg}>
              {message.image && (
                <img className={styles.photo} src={message.image} alt="фото задания" />
              )}
              {message.text && <p className={styles.userText}>{message.text}</p>}
            </div>
          ) : (
            <article
              key={index}
              className={`${styles.card} ${message.error ? styles.cardError : ''}`}
            >
              <div className={styles.cardHead}>
                <span className={styles.cardLabel}>{message.label}</span>
                {typeof message.ms === 'number' && !message.error && (
                  <span className={styles.ms}>{(message.ms / 1000).toFixed(1)} с</span>
                )}
              </div>
              <p className={styles.answer}>{message.text}</p>
            </article>
          ),
        )}

        {pending && (
          <div className={styles.thinking}>
            <span className={styles.dot} />
            <span className={styles.dot} />
            <span className={styles.dot} />
            <span className={styles.thinkingText}>спрашиваем модели…</span>
          </div>
        )}

        <div ref={bottomRef} />
      </main>

      <form className={styles.composer} onSubmit={handleSubmit}>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          capture="environment"
          className={styles.hiddenInput}
          onChange={handlePhoto}
        />
        <button
          type="button"
          className={styles.photoBtn}
          onClick={() => fileRef.current?.click()}
          disabled={pending}
          aria-label="Прикрепить фото задания"
          title="Прикрепить фото задания"
        >
          📷
        </button>
        <input
          className={styles.input}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="или напиши вопрос текстом"
          aria-label="Вопрос текстом"
        />
        <button type="submit" className={styles.send} disabled={pending || !text.trim()}>
          {pending ? '…' : '→'}
        </button>
      </form>
    </div>
  )
}
