import type { VercelRequest, VercelResponse } from '@vercel/node'

const MODELS: { id: string; orName: string; prompt?: string }[] = [
  { id: 'claude', orName: 'anthropic/claude-sonnet-4-6' },
  { id: 'gemini', orName: 'google/gemini-3-pro-preview' },
  { id: 'deepseek', orName: 'deepseek/deepseek-chat' },
  { id: 'chatgpt', orName: 'openai/gpt-4.1' },
]

const PROMPT = `Фото содержит один школьный тест с вариантами ответов A, B, C, D.
Верни только вариант ответа одним словом: A, B, C или D.
Если невозможно определить, верни NOTHING. Не добавляй пояснений.`

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'только POST' })
  }

  const body = req.body
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'нет тела запроса' })
  }

  const text = typeof body.text === 'string' ? body.text : ''
  const image = typeof body.image === 'string' ? body.image : null
  const selectedModels = Array.isArray(body.models)
    ? body.models.filter((m): m is string => typeof m === 'string')
    : MODELS.map((m) => m.id)

  if (!selectedModels.length) {
    return res.status(400).json({ error: 'не выбрано ни одной модели' })
  }

  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) {
    return res.status(500).json({ error: 'OPENROUTER_API_KEY не задан' })
  }

  const tasks = selectedModels.map(async (modelId) => {
    const modelConfig = MODELS.find((m) => m.id === modelId)
    if (!modelConfig) return { model: modelId.toUpperCase(), text: 'Нет такой модели в конфиге' }

    const prompt = modelConfig.prompt ?? PROMPT
    const userContent: { type: string; text?: string; image_url?: { url: string } }[] = []

    if (text) userContent.push({ type: 'text', text })
    if (image) userContent.push({ type: 'image_url', image_url: { url: image } })
    if (!userContent.length) userContent.push({ type: 'text', text: 'Проанализируй фото и ответь.' })

    try {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://yourdomain.example',
          'X-Title': 'AI Exam Chat',
        },
        body: JSON.stringify({
          model: modelConfig.orName,
          messages: [
            { role: 'system', content: prompt },
            { role: 'user', content: userContent },
          ],
          max_tokens: 300,
          temperature: 0.2,
        }),
      })

      if (!r.ok) {
        const errBody = await r.text()
        throw new Error(`${r.status}: ${errBody.slice(0, 500)}`)
      }

      const data = (await r.json()) as { choices?: { message?: { content?: string } }[] }
      const content = data.choices?.[0]?.message?.content?.trim() ?? ''
      return { model: modelId.toUpperCase(), text: content || 'пустой ответ' }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'ошибка'
      return { model: modelId.toUpperCase(), text: `Ошибка: ${message}` }
    }
  })

  const responses = await Promise.allSettled(tasks)
  const completed: { model: string; text: string }[] = []

  for (const result of responses) {
    if (result.status === 'fulfilled') {
      completed.push(result.value)
    } else {
      completed.push({ model: '?', text: `Ошибка выполнения: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}` })
    }
  }

  return res.status(200).json({ responses: completed })
}
