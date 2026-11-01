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

interface ModelConfig {
  id: ModelId
  label: string
  slug: string
}

// Slug'и сверены с каталогом OpenRouter: все четыре модели принимают изображения.
const MODELS: ModelConfig[] = [
  { id: 'claude', label: 'CLAUDE', slug: 'anthropic/claude-sonnet-4.6' },
  { id: 'gemini', label: 'GEMINI', slug: 'google/gemini-3-pro-image-preview' },
  { id: 'deepseek', label: 'DEEPSEEK', slug: 'deepseek/deepseek-v4.1-flash' },
  { id: 'chatgpt', label: 'ChatGPT', slug: 'openai/gpt-4.1' },
]

const SYSTEM_PROMPT = `Ты помогаешь решить школьный тест (СОР/СОЧ).
На фото или в тексте — задание с вариантами ответов A, B, C, D.
Ответь строго в таком формате:
ОТВЕТ: <одна буква>
<одно короткое предложение пояснения, максимум 12 слов>
Если задание не читается, напиши: ОТВЕТ: ?`

const TIMEOUT_MS = 25_000

interface ModelReply {
  id: string
  label: string
  text: string
  ms: number
  error?: boolean
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

  const payload = body as { text?: unknown; image?: unknown; models?: unknown }
  const text = typeof payload.text === 'string' ? payload.text.trim() : ''
  const image = typeof payload.image === 'string' ? payload.image : ''
  const requested = Array.isArray(payload.models)
    ? payload.models.filter((m): m is string => typeof m === 'string')
    : MODELS.map((m) => m.id)

  const selected = MODELS.filter((m) => requested.includes(m.id))

  if (!selected.length) {
    return res.status(400).json({ error: 'не выбрано ни одной модели' })
  }
  if (!text && !image) {
    return res.status(400).json({ error: 'нужен текст вопроса или фото' })
  }

  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) {
    return res.status(500).json({ error: 'OPENROUTER_API_KEY не задан в окружении' })
  }

  const question = text || 'Реши задание с фотографии.'

  const replies = await Promise.all(
    selected.map((model): Promise<ModelReply> => askModel(model, question, image, apiKey)),
  )

  res.setHeader('Cache-Control', 'no-store')
  return res.status(200).json({ responses: replies })
}

async function askModel(
  model: ModelConfig,
  question: string,
  image: string,
  apiKey: string,
): Promise<ModelReply> {
  const startedAt = Date.now()

  const content: Array<Record<string, unknown>> = [{ type: 'text', text: question }]
  if (image) {
    content.push({ type: 'image_url', image_url: { url: image } })
  }

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'X-Title': 'AI Exam Chat',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({
        model: model.slug,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content },
        ],
        max_tokens: 200,
        temperature: 0,
      }),
    })

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300)
      throw new Error(`${response.status} ${detail}`)
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const answer = data.choices?.[0]?.message?.content?.trim() ?? ''

    return {
      id: model.id,
      label: model.label,
      text: answer || 'Модель вернула пустой ответ.',
      ms: Date.now() - startedAt,
    }
  } catch (error) {
    const reason =
      error instanceof Error && error.name === 'TimeoutError'
        ? 'превышено время ожидания'
        : error instanceof Error
          ? error.message
          : 'неизвестная ошибка'

    return {
      id: model.id,
      label: model.label,
      text: `Ошибка: ${reason}`,
      ms: Date.now() - startedAt,
      error: true,
    }
  }
}
