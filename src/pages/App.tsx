import { useEffect, useMemo, useRef, useState } from 'react'

import styles from './App.module.css'

const MODELS = [
  { id: 'claude', label: 'Claude', accent: '#d97757' },
  { id: 'gemini', label: 'Gemini', accent: '#4f8cff' },
  { id: 'deepseek', label: 'DeepSeek', accent: '#a78bfa' },
  { id: 'chatgpt', label: 'ChatGPT', accent: '#10a37f' },
] as const

type ModelId = (typeof MODELS)[number]['id']

interface Reply {
  id: string
  label: string
  text: string
  ms?: number
  error?: boolean
  reason?: string
}

interface UserMessage {
  kind: 'user'
  turn: number
  text: string
  image?: string
}

interface AiMessage {
  kind: 'ai'
  turn: number
  modelId: string
  label: string
  accent: string
  text: string
  error?: boolean
  reason?: string
}

type Message = UserMessage | AiMessage

/** Короткие ярлыки причин сбоя — сервер присылает код, текст причины уже в теле. */
const REASON_LABELS: Record<string, string> = {
  limit: 'Лимит',
  timeout: 'Таймаут',
  network: 'Нет связи',
  provider: 'Ошибка провайдера',
  empty: 'Пустой ответ',
  reasoning: 'Без решения',
  noKeys: 'Нет ключей',
}

const MAX_SIDE = 1400
const JPEG_QUALITY = 0.82
const MAX_TEXTAREA = 168
const STORAGE_KEY = 'exam-ai:session:v1'
const MEMORY_KEY = 'exam-ai:memory:v1'
const CONSENT_KEY = 'exam-ai:consent:v1'
const DEFAULT_MEMORY = 3
const MAX_MEMORY = 8
/** Держим в согласии с сервером: длиннее он отклонит с ошибкой 413. */
const MAX_TEXT = 4000

/** Выбор в баннере хранилища: null — пользователь ещё не отвечал. */
type ConsentChoice = 'all' | 'necessary'

interface HistoryEntry {
  role: 'user' | 'assistant'
  text: string
  modelId?: string
}

function pluralTurns(count: number): string {
  const mod100 = count % 100
  const mod10 = count % 10
  if (mod10 === 1 && mod100 !== 11) return 'ход'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'хода'
  return 'ходов'
}

function loadConsent(): ConsentChoice | null {
  try {
    const raw = localStorage.getItem(CONSENT_KEY)
    return raw === 'all' || raw === 'necessary' ? raw : null
  } catch {
    return null
  }
}

function loadMemory(): number {
  try {
    const raw = Number(localStorage.getItem(MEMORY_KEY))
    if (!Number.isFinite(raw)) return DEFAULT_MEMORY
    return Math.max(0, Math.min(MAX_MEMORY, Math.round(raw)))
  } catch {
    return DEFAULT_MEMORY
  }
}

/** Берёт последние N ходов вместе с ответами, чтобы отправить их как контекст. */
function buildHistory(all: Message[], limitTurns: number): HistoryEntry[] {
  if (limitTurns <= 0) return []

  let seen = 0
  let start = all.length
  for (let i = all.length - 1; i >= 0; i -= 1) {
    if (all[i].kind !== 'user') continue
    seen += 1
    if (seen > limitTurns) break
    start = i
  }

  return all
    .slice(start)
    .filter((message) => (message.kind === 'ai' ? message.modelId !== 'system' : true) && message.text.trim())
    .map((message) =>
      message.kind === 'user'
        ? { role: 'user' as const, text: message.text }
        : { role: 'assistant' as const, text: message.text, modelId: message.modelId },
    )
}

/** Сжимает фото в data-URL: blob-URL сервер прочитать не может. */
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

function accentFor(modelId: string): string {
  return MODELS.find((m) => m.id === modelId)?.accent ?? '#8b93a7'
}

/** Отделяет «ОТВЕТ: B» от пояснения, чтобы показать букву отдельно. */
function splitAnswer(text: string): { letter?: string; body: string } {
  const match = text.match(/ОТВЕТ\s*[:：]\s*([A-Da-d?])[^\n]*/)
  if (!match) return { body: text }
  return {
    letter: match[1].toUpperCase(),
    body: text.replace(match[0], '').trim(),
  }
}

function renderInline(text: string) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((chunk, index) =>
    chunk.startsWith('**') && chunk.endsWith('**') ? (
      <strong key={index}>{chunk.slice(2, -2)}</strong>
    ) : (
      <span key={index}>{chunk}</span>
    ),
  )
}

function loadMessages(): Message[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as { messages?: Message[] }
    return Array.isArray(parsed.messages) ? parsed.messages : []
  } catch {
    return []
  }
}

export function App() {
  const [messages, setMessages] = useState<Message[]>(loadMessages)
  const [pending, setPending] = useState(false)
  const [memoryTurns, setMemoryTurns] = useState(loadMemory)
  const [consent, setConsent] = useState<ConsentChoice | null>(loadConsent)
  const [text, setText] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [enabled, setEnabled] = useState<Record<ModelId, boolean>>({
    claude: true,
    gemini: true,
    deepseek: true,
    chatgpt: true,
  })

  const fileRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const activeModels = MODELS.filter((m) => enabled[m.id])
  const empty = messages.length === 0 && !pending
  const turnsSoFar = messages.filter((message) => message.kind === 'user').length
  const memoryUsed = Math.min(memoryTurns, turnsSoFar)
  const memoryHint =
    memoryTurns === 0
      ? 'Контекст выключен: каждый вопрос с нуля.'
      : turnsSoFar === 0
        ? `Модели запомнят до ${memoryTurns} ${pluralTurns(memoryTurns)}.`
        : `Учитывается ${memoryUsed} из ${memoryTurns} ${pluralTurns(memoryTurns)}.`

  /** Победившая буква по каждому вопросу — чтобы отметить совпадение. */
  const consensus = useMemo(() => {
    const byTurn = new Map<number, Map<string, number>>()
    for (const message of messages) {
      if (message.kind !== 'ai' || message.error) continue
      const letter = splitAnswer(message.text).letter
      if (!letter || letter === '?') continue
      const votes = byTurn.get(message.turn) ?? new Map<string, number>()
      votes.set(letter, (votes.get(letter) ?? 0) + 1)
      byTurn.set(message.turn, votes)
    }

    const result = new Map<number, { letter: string; count: number }>()
    for (const [turn, votes] of byTurn) {
      let best: { letter: string; count: number } | null = null
      for (const [letter, count] of votes) {
        if (!best || count > best.count) best = { letter, count }
      }
      if (best) result.set(turn, best)
    }
    return result
  }, [messages])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, pending])

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA)}px`
  }, [text])

  // Сессия переживает перезагрузку страницы. Фото не сохраняем — они слишком тяжёлые.
  useEffect(() => {
    try {
      const slim = messages.map((message) =>
        message.kind === 'user' ? { ...message, image: undefined } : message,
      )
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ messages: slim }))
    } catch {
      /* приватный режим — просто работаем без сохранения */
    }
  }, [messages])

  useEffect(() => {
    try {
      localStorage.setItem(MEMORY_KEY, String(memoryTurns))
    } catch {
      /* ignore */
    }
  }, [memoryTurns])

  function toggleModel(id: ModelId) {
    setEnabled((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  async function ask(question: string, photo?: string) {
    const trimmed = question.trim()
    if ((!trimmed && !photo) || pending) return

    if (!activeModels.length) {
      setMessages((prev) => [
        ...prev,
        {
          kind: 'ai',
          turn: 0,
          modelId: 'system',
          label: 'Внимание',
          accent: '#f59e0b',
          text: 'Включи хотя бы одну модель в меню слева.',
          error: true,
        },
      ])
      return
    }

    const turn = messages.filter((message) => message.kind === 'user').length + 1
    setPending(true)
    setText('')

    // Память диалога: предыдущие ходы уходят на сервер, чтобы модели держали контекст.
    const history = buildHistory(messages, memoryTurns)

    setMessages((prev) => [...prev, { kind: 'user', turn, text: trimmed, image: photo }])

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: trimmed,
          image: photo ?? '',
          models: activeModels.map((m) => m.id),
          history,
          memory: memoryTurns,
        }),
      })

      const data = (await response.json().catch(() => null)) as
        | { responses?: Reply[]; error?: string }
        | null

      if (!response.ok) throw new Error(data?.error ?? `сервер ответил ${response.status}`)

      const replies = data?.responses ?? []
      if (!replies.length) throw new Error('сервер вернул пустой список ответов')

      setMessages((prev) => [
        ...prev,
        ...replies.map<Message>((reply) => ({
          kind: 'ai',
          turn,
          modelId: reply.id,
          label: reply.label ?? reply.id,
          accent: accentFor(reply.id),
          text: reply.text,
          error: reply.error,
          reason: reply.reason,
        })),
      ])
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'неизвестная ошибка'
      setMessages((prev) => [
        ...prev,
        {
          kind: 'ai',
          turn,
          modelId: 'system',
          label: 'Ошибка',
          accent: '#ef4444',
          text: reason,
          error: true,
        },
      ])
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
      setMessages((prev) => [
        ...prev,
        {
          kind: 'ai',
          turn: 0,
          modelId: 'system',
          label: 'Ошибка',
          accent: '#ef4444',
          text: reason,
          error: true,
        },
      ])
    }
  }

  function submit() {
    void ask(text)
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submit()
    }
  }

  function resetChat() {
    setMessages([])
    setText('')
    setSidebarOpen(false)
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {
      /* ignore */
    }
  }

  function chooseConsent(choice: ConsentChoice) {
    setConsent(choice)
    try {
      localStorage.setItem(CONSENT_KEY, choice)
    } catch {
      /* приватный режим — выбор не запомнится, баннер покажется снова */
    }
  }

  return (
    <div className={styles.root}>
      <aside className={`${styles.sidebar} ${sidebarOpen ? styles.sidebarOpen : ''}`}>
        <div className={styles.brand}>
          <span className={styles.brandMark}>Σ</span>
          <span className={styles.brandName}>Exam AI</span>
        </div>

        <button type="button" className={styles.newChat} onClick={resetChat}>
          <span className={styles.plus}>+</span> Новый чат
        </button>

        <ul className={styles.modelList}>
          {MODELS.map((model) => (
            <li key={model.id}>
              <button
                type="button"
                className={styles.modelRow}
                onClick={() => toggleModel(model.id)}
                aria-pressed={enabled[model.id]}
              >
                <span className={styles.modelDot} style={{ background: model.accent }} />
                <span className={styles.modelName}>{model.label}</span>
                <span className={`${styles.switch} ${enabled[model.id] ? styles.switchOn : ''}`} />
              </button>
            </li>
          ))}
        </ul>

        <div className={styles.memory}>
          <div className={styles.memoryHead}>
            <span className={styles.memoryTitle}>Память диалога</span>
            <span className={styles.memoryValue}>
              {memoryTurns} {pluralTurns(memoryTurns)}
            </span>
          </div>
          <input
            className={styles.range}
            type="range"
            min={0}
            max={MAX_MEMORY}
            step={1}
            value={memoryTurns}
            onChange={(event) => setMemoryTurns(Number(event.target.value))}
            aria-label="Сколько прошлых ходов учитывать"
          />
          <p className={styles.memoryHint}>{memoryHint}</p>
        </div>

        <nav className={styles.legalNav} aria-label="Правовая информация">
          <a className={styles.legalLink} href="/privacy">
            Политика конфиденциальности
          </a>
          <a className={styles.legalLink} href="/cookies">
            Cookie и хранилище
          </a>
          <a className={styles.legalLink} href="/terms">
            Пользовательское соглашение
          </a>
        </nav>
      </aside>

      {sidebarOpen && (
        <button
          type="button"
          className={styles.overlay}
          aria-label="Закрыть меню"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <main className={styles.main}>
        <button
          type="button"
          className={styles.menuBtn}
          onClick={() => setSidebarOpen((open) => !open)}
          aria-label="Меню"
        >
          ☰
        </button>

        {!empty && (
          <div className={styles.scroll} ref={scrollRef}>
            <div className={styles.thread}>
              {messages.map((message, index) => {
                if (message.kind === 'user') {
                  return (
                    <div key={index} className={styles.userRow}>
                      <div className={styles.userBubble}>
                        {message.image && (
                          <img className={styles.userPhoto} src={message.image} alt="задание" />
                        )}
                        {message.text && <p className={styles.userText}>{message.text}</p>}
                      </div>
                    </div>
                  )
                }

                const { letter, body } = splitAnswer(message.text)
                const vote = consensus.get(message.turn)
                const matched =
                  Boolean(letter) && Boolean(vote) && vote!.count >= 2 && vote!.letter === letter

                return (
                  <article key={index} className={styles.aiRow}>
                    <span
                      className={styles.avatar}
                      style={{ background: `${message.accent}22`, color: message.accent }}
                    >
                      {message.label.slice(0, 1).toUpperCase()}
                    </span>
                    <div className={styles.aiBody}>
                      <p className={styles.aiName}>{message.label}</p>
                      <div className={`${styles.aiText} ${message.error ? styles.aiError : ''}`}>
                        {message.error && message.reason && (
                          <span className={styles.reason}>
                            {REASON_LABELS[message.reason] ?? 'Сбой'}
                          </span>
                        )}
                        {letter && (
                          <span
                            className={`${styles.letter} ${matched ? styles.letterMatch : ''}`}
                            style={{ color: message.accent, background: `${message.accent}1f` }}
                          >
                            {letter}
                          </span>
                        )}
                        <p className={styles.aiParagraph}>{renderInline(body)}</p>
                      </div>
                    </div>
                  </article>
                )
              })}

              {pending &&
                activeModels.map((model) => (
                  <article key={`ghost-${model.id}`} className={styles.aiRow}>
                    <span
                      className={styles.avatar}
                      style={{ background: `${model.accent}22`, color: model.accent }}
                    >
                      {model.label.slice(0, 1)}
                    </span>
                    <div className={styles.aiBody}>
                      <p className={styles.aiName}>{model.label}</p>
                      <div className={styles.ghost}>
                        <span className={styles.ghostLine} />
                        <span className={styles.ghostLine} />
                      </div>
                    </div>
                  </article>
                ))}
            </div>
          </div>
        )}

        <div className={`${styles.composerWrap} ${empty ? styles.composerCenter : ''}`}>
          {empty && (
            <div className={styles.hero}>
              <span className={styles.heroMark}>Σ</span>
              <h1 className={styles.heroTitle}>Четыре модели на один вопрос</h1>
              <p className={styles.heroText}>
                Вставь текст задания или прикрепи фото. Claude, Gemini, DeepSeek и ChatGPT ответят
                параллельно, а совпавшая буква подсветится зелёным.
              </p>
              <ul className={styles.heroTips}>
                <li>СОР и СОЧ как есть</li>
                <li>Фото задания — кнопкой «+»</li>
                <li>Enter — отправить</li>
              </ul>
            </div>
          )}
          <div className={styles.composer}>
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
              className={styles.attach}
              onClick={() => fileRef.current?.click()}
              disabled={pending}
              aria-label="Прикрепить фото"
            >
              +
            </button>
            <textarea
              ref={textareaRef}
              className={styles.textarea}
              value={text}
              rows={1}
              maxLength={MAX_TEXT}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Сообщение"
              aria-label="Сообщение"
            />
            <button
              type="button"
              className={styles.sendBtn}
              onClick={submit}
              disabled={pending || !text.trim()}
              aria-label="Отправить"
            >
              ↑
            </button>
          </div>
          <p className={styles.disclaimer}>
            ИИ может ошибаться. Ответы для самопроверки.{" "}
            <a className={styles.disclaimerLink} href="/terms">
              Условия
            </a>
          </p>
        </div>
      </main>

      {consent === null && (
        <section className={styles.consent} aria-label="Использование локального хранилища">
          <p className={styles.consentText}>
            <span className={styles.consentTitle}>Cookie и локальное хранилище</span>
            Cookie сайт не ставит, аналитики нет. В вашем браузере сохраняются история чата и
            настройка памяти — без них чат не переживёт перезагрузку. Подробнее:{" "}
            <a className={styles.consentLink} href="/privacy">
              политика конфиденциальности
            </a>{" "}
            и <a className={styles.consentLink} href="/cookies">cookie</a>.
          </p>
          <div className={styles.consentActions}>
            <button
              type="button"
              className={styles.consentGhost}
              onClick={() => chooseConsent('necessary')}
            >
              Только необходимое
            </button>
            <button
              type="button"
              className={styles.consentPrimary}
              onClick={() => chooseConsent('all')}
            >
              Принять
            </button>
          </div>
        </section>
      )}
    </div>
  )
}
