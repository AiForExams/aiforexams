interface ApiRequest {
  method?: string
  body?: unknown
}

interface ApiResponse {
  setHeader(name: string, value: string): void
  status(code: number): ApiResponse
  json(payload: unknown): void
}

declare const process: { env: Record<string, string | undefined> }

type ModelId = 'claude' | 'gemini' | 'deepseek' | 'chatgpt'
type Provider = 'openrouter' | 'orcarouter'

/** Один вариант модели, на который можно переключиться, если предыдущий упёрся в лимит. */
interface Candidate {
  slug: string
  provider: Provider
  vision: boolean
}

interface ModelConfig {
  id: ModelId
  label: string
  /** Порядок перебора: первый рабочий вариант и бесплатные резервы. */
  chain: Candidate[]
  /** Характер ответа, под который подстраивается модель. */
  persona: string
}

interface ModelReply {
  id: string
  label: string
  text: string
  ms: number
  error?: boolean
}

/** Реплика прошлых ходов: память диалога. */
interface HistoryItem {
  role: 'user' | 'assistant'
  text: string
  /** Для assistant — какой слот отвечал, чтобы каждый видел только свои ответы. */
  modelId?: string
}

const ENDPOINTS: Record<Provider, string> = {
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  orcarouter: 'https://api.orcarouter.ai/v1/chat/completions',
}

const VISION_TRANSCRIBER: Candidate = {
  slug: 'nvidia/nemotron-3.5-super-vl:free',
  provider: 'openrouter',
  vision: true,
}

// Только бесплатные модели: у OpenRouter слаг с суффиксом :free, у OrcaRouter — с -free.
const MODELS: ModelConfig[] = [
  {
    id: 'claude',
    label: 'CLAUDE',
    chain: [
      { slug: 'nvidia/nemotron-3-ultra-550b-a55b:free', provider: 'openrouter', vision: false },
      { slug: 'nvidia/nemotron-3.5-super-vl:free', provider: 'openrouter', vision: true },
    ],
    persona:
      'Отвечай в манере Claude: сначала молча разбери условие и определи, что именно спрашивают, затем аккуратно реши, проверь результат и только потом напиши ответ. Тон спокойный и точный, без вступлений и без воды.',
  },
  {
    id: 'gemini',
    label: 'GEMINI',
    chain: [
      { slug: 'google/gemma-4-26b-a4b-it:free', provider: 'openrouter', vision: true },
      { slug: 'google/gemma-4-31b-it:free', provider: 'openrouter', vision: true },
      { slug: 'nvidia/nemotron-3.5-super-vl:free', provider: 'openrouter', vision: true },
    ],
    persona:
      'Отвечай в манере Gemini: быстро схвати суть задания, реши его и обязательно проверь ответ обратным действием или подстановкой в исходное условие. Пояснение — одно короткое предложение.',
  },
  {
    id: 'deepseek',
    label: 'DEEPSEEK',
    chain: [
      { slug: 'deepseek/deepseek-v4.1-flash-free', provider: 'orcarouter', vision: true },
      { slug: 'google/gemma-4-31b-it:free', provider: 'openrouter', vision: true },
      { slug: 'nvidia/nemotron-3.5-super-vl:free', provider: 'openrouter', vision: true },
    ],
    persona:
      'Отвечай в манере DeepSeek: веди строгую пошаговую проверку вычислений про себя, сверь полученное значение с каждым вариантом и выведи только итог. Никаких промежуточных рассуждений в ответе.',
  },
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    chain: [
      { slug: 'nvidia/nemotron-3.5-super-vl:free', provider: 'openrouter', vision: true },
      { slug: 'google/gemma-4-31b-it:free', provider: 'openrouter', vision: true },
    ],
    persona:
      'Отвечай в манере ChatGPT: разложи решение на шаги, затем перепроверь, что выбранная буква указывает именно на то значение, которое ты получил. Вывод короткий и уверенный.',
  },
]

const VISION_PROMPT =
  'Распознай всю информацию с изображения дословно: текст задания, номера, формулы, варианты ответов с их буквами. Сохрани структуру и порядок. Выведи только распознанный текст, без комментариев.'

const SCHOOL_SUBJECT_RULES = [
  'Ты — помощник по школьным тестам СОР/СОЧ (5–11 класс, Ташкент).',
  '',
  'Отвечай не угадыванием буквы, а проверкой. Сначала определи предмет и тему задания.',
  'Для вычислительных предметов (математика, алгебра, геометрия, физика, химия) — реши задачу по шагам, затем подставь полученное значение в каждый вариант, выбери совпавший и напиши короткую проверку.',
  'Для предметной грамотности (биология, география, история, обществознание, русский язык, английский язык) — проверь каждый вариант по учебному факту, выбери тот, который соответствует проверке, и напиши короткую проверку.',
  '',
  'Продолжай диалог: если в предыдущих ходах были задания, учитывай их и не противоречь своим прошлым ответам без причины. Если новый вопрос ссылается на прошлый («а если…», «почему не B»), отвечай с учётом этого контекста.',
  '',
  'В конце ответа — отдельная строка: ОТВЕТ: <буква>) <текст варианта>.',
  'Коротко, точно, без воды. Не говори о себе, не отказывайся от вопроса.',
].join('\n')

const MAX_TOKENS = 400
const TRANSCRIBE_TOKENS = 900
const TIMEOUT_MS = 40_000
const SLOT_BUDGET_MS = 80_000
const DEFAULT_MEMORY_TURNS = 3
const MAX_MEMORY_TURNS = 12
/** Один ход — это вопрос и до четырёх ответов моделей. */
const MESSAGES_PER_TURN = 5
const MAX_HISTORY_CHARS = 1_200

interface Account {
  openrouter?: string
  orcarouter?: string
}

/** Два аккаунта на каждого провайдера: при 429 слот переключается на следующий ключ. */
function accounts(): Account[] {
  const list: Account[] = [
    { openrouter: process.env.OPENROUTER_API_KEY, orcarouter: process.env.ORCAROUTER_API_KEY },
    { openrouter: process.env.OPENROUTER_API_KEY2, orcarouter: process.env.ORCAROUTER_API_KEY2 },
  ]
  return list.filter((account) => account.openrouter || account.orcarouter)
}

function keyFor(account: Account, provider: Provider): string {
  return (provider === 'openrouter' ? account.openrouter : account.orcarouter) ?? ''
}

class HttpError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function describe(error: unknown): string {
  if (error instanceof HttpError) return `${error.status} ${error.message}`
  if (error instanceof Error && error.name === 'TimeoutError') return 'превышено время ожидания'
  if (error instanceof Error) return error.message
  return 'неизвестная ошибка'
}

async function complete(
  provider: Provider,
  apiKey: string,
  slug: string,
  messages: Array<Record<string, unknown>>,
  maxTokens: number,
  timeoutMs: number,
): Promise<string> {
  const response = await fetch(ENDPOINTS[provider], {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'X-Title': 'AI Exam Chat',
    },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model: slug,
      messages,
      max_tokens: maxTokens,
      temperature: 0,
    }),
  })

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 200)
    throw new HttpError(response.status, detail)
  }

  const data = (await response.json()) as {
    choices?: Array<{
      message?: { content?: string | null; reasoning?: string | null; reasoning_content?: string | null }
    }>
  }
  const message = data.choices?.[0]?.message
  const answer = (message?.content || message?.reasoning_content || message?.reasoning || '').trim()
  return answer
}

/** Приводит ответ к виду «...пояснение...\nОТВЕТ: B) 56». */
function extractAnswer(raw: string): string {
  const text = raw.trim()
  if (!text) return ''

  const match = text.match(/ОТВЕТ\s*[:：]\s*([A-Da-d?])\s*[).:\-–—]?\s*([^\n]*)/i)
  if (match) {
    const letter = match[1].toUpperCase()
    const tail = match[2].trim().replace(/^[).:\-–—]+\s*/, '')
    const line = tail ? `ОТВЕТ: ${letter}) ${tail}` : `ОТВЕТ: ${letter}`
    const body = text.replace(match[0], '').trim()
    return body ? `${body}\n${line}` : line
  }

  const inline =
    text.match(/(?:правильн\w*|верн\w*|ответ)\D{0,20}?\b([A-D])\b/i) ?? text.match(/\b([A-D])\)/)
  if (!inline) return text

  const letter = inline[1].toUpperCase()
  const tailMatch = text.match(new RegExp(`\\b${letter}\\)\\s*([^\\n,;.]{1,60})`))
  const tail = tailMatch ? tailMatch[1].trim() : ''
  return `${text}\nОТВЕТ: ${letter}${tail ? `) ${tail}` : ''}`
}

/** Фото распознаём один раз на запрос, если в цепочке есть модель без зрения. */
async function transcribeImage(image: string): Promise<string> {
  for (const account of accounts()) {
    const apiKey = keyFor(account, VISION_TRANSCRIBER.provider)
    if (!apiKey) continue
    try {
      const text = await complete(
        VISION_TRANSCRIBER.provider,
        apiKey,
        VISION_TRANSCRIBER.slug,
        [
          { role: 'system', content: 'Ты распознаёшь текст с фотографий школьных тестов.' },
          {
            role: 'user',
            content: [
              { type: 'text', text: VISION_PROMPT },
              { type: 'image_url', image_url: { url: image } },
            ],
          },
        ],
        TRANSCRIBE_TOKENS,
        TIMEOUT_MS,
      )
      if (text) return text
    } catch {
      /* пробуем следующий аккаунт */
    }
  }
  return ''
}

function buildMessages(
  model: ModelConfig,
  candidate: Candidate,
  question: string,
  image: string,
  imageText: string,
  history: HistoryItem[],
): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [
    { role: 'system', content: `${SCHOOL_SUBJECT_RULES}\n\n${model.persona}` },
  ]

  for (const item of history) {
    const text = item.text.trim().slice(0, MAX_HISTORY_CHARS)
    if (!text) continue
    if (item.role === 'user') {
      messages.push({ role: 'user', content: text })
    } else if (item.modelId === model.id) {
      // Каждый слот помнит только собственные ответы, чтобы не копировать чужие.
      messages.push({ role: 'assistant', content: text })
    }
  }

  const parts = [question]
  if (imageText) parts.push(`Текст с фотографии, распознанный дословно:\n${imageText}`)
  const textPart = parts.filter(Boolean).join('\n\n')

  if (image && candidate.vision) {
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: textPart },
        { type: 'image_url', image_url: { url: image } },
      ],
    })
  } else {
    messages.push({ role: 'user', content: textPart })
  }

  return messages
}

async function askModel(
  model: ModelConfig,
  question: string,
  image: string,
  imageText: string,
  history: HistoryItem[],
): Promise<ModelReply> {
  const startedAt = Date.now()
  const deadline = startedAt + SLOT_BUDGET_MS
  let lastError = 'нет доступных ключей'

  for (const candidate of model.chain) {
    if (Date.now() > deadline) break
    // Модель без зрения без распознанного текста бесполезна — сразу к резерву.
    if (image && !candidate.vision && !imageText) continue

    for (const account of accounts()) {
      const apiKey = keyFor(account, candidate.provider)
      if (!apiKey) continue

      const remaining = deadline - Date.now()
      if (remaining < 5_000) break

      try {
        const messages = buildMessages(model, candidate, question, image, imageText, history)
        const answer = await complete(
          candidate.provider,
          apiKey,
          candidate.slug,
          messages,
          MAX_TOKENS,
          Math.min(TIMEOUT_MS, remaining),
        )
        if (answer) {
          return {
            id: model.id,
            label: model.label,
            text: extractAnswer(answer),
            ms: Date.now() - startedAt,
          }
        }
        lastError = 'модель вернула пустой ответ'
      } catch (error) {
        lastError = describe(error)
      }
    }
  }

  return {
    id: model.id,
    label: model.label,
    text: `Ошибка: ${lastError}`,
    ms: Date.now() - startedAt,
    error: true,
  }
}

function parseMemory(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MEMORY_TURNS
  return Math.max(0, Math.min(MAX_MEMORY_TURNS, Math.floor(value)))
}

function parseHistory(value: unknown, limit: number): HistoryItem[] {
  if (limit <= 0 || !Array.isArray(value)) return []
  const items: HistoryItem[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const item = entry as { role?: unknown; text?: unknown; modelId?: unknown }
    if (item.role !== 'user' && item.role !== 'assistant') continue
    if (typeof item.text !== 'string' || !item.text.trim()) continue
    items.push({
      role: item.role,
      text: item.text,
      modelId: typeof item.modelId === 'string' ? item.modelId : undefined,
    })
  }
  return items.slice(-limit)
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'только POST' })
  }

  const body = req.body
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'нет тела запроса' })
  }

  const payload = body as {
    text?: unknown
    image?: unknown
    models?: unknown
    history?: unknown
    memory?: unknown
  }
  const text = typeof payload.text === 'string' ? payload.text.trim() : ''
  const image = typeof payload.image === 'string' ? payload.image : ''
  const requested = Array.isArray(payload.models)
    ? payload.models.filter((m): m is string => typeof m === 'string')
    : MODELS.map((m) => m.id)
  const memoryTurns = parseMemory(payload.memory)
  const history = parseHistory(payload.history, memoryTurns * MESSAGES_PER_TURN)

  const selected = MODELS.filter((m) => requested.includes(m.id))

  if (!selected.length) {
    return res.status(400).json({ error: 'не выбрано ни одной модели' })
  }
  if (!text && !image) {
    return res.status(400).json({ error: 'нужен текст вопроса или фото' })
  }
  if (!accounts().length) {
    return res.status(500).json({ error: 'ключи OpenRouter / OrcaRouter не заданы в окружении' })
  }

  const question = text || 'Реши задание с фотографии.'

  // Распознаём фото только если оно нужно кому-то из выбранных слотов.
  const needsTranscription =
    Boolean(image) &&
    selected.some((model) => model.chain.some((candidate) => !candidate.vision))
  const imageText = needsTranscription ? await transcribeImage(image) : ''

  const replies = await Promise.all(
    selected.map((model) => askModel(model, question, image, imageText, history)),
  )

  res.setHeader('Cache-Control', 'no-store')
  return res.status(200).json({ responses: replies })
}
