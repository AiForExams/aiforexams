import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Локальный аналог Vercel-функции: без него `npm run dev` отдаёт 404 на /api/chat,
 * и проверить фото можно только через `vercel dev`.
 */
function localApi(env: Record<string, string>): Plugin {
  return {
    name: 'local-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api/chat', async (req, res) => {
        const json = (code: number, payload: unknown) => {
          res.statusCode = code
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(payload))
        }

        if (req.method !== 'POST') return json(405, { error: 'только POST' })

        let raw = ''
        for await (const chunk of req) raw += chunk

        let body: unknown = {}
        try {
          body = raw ? JSON.parse(raw) : {}
        } catch {
          return json(400, { error: 'некорректный JSON' })
        }

        for (const name of [
          'OPENROUTER_API_KEY',
          'ORCAROUTER_API_KEY',
          'OPENROUTER_API_KEY2',
          'ORCAROUTER_API_KEY2',
          'GEMINI_API_KEY',
        ]) {
          if (!process.env[name] && env[name]) process.env[name] = env[name]
        }

        let statusCode = 200
        const headers: Record<string, string> = {}
        const apiRes = {
          setHeader(name: string, value: string) {
            headers[name] = value
          },
          status(code: number) {
            statusCode = code
            return apiRes
          },
          json(payload: unknown) {
            res.statusCode = statusCode
            res.setHeader('Content-Type', 'application/json')
            for (const [name, value] of Object.entries(headers)) res.setHeader(name, value)
            res.end(JSON.stringify(payload))
          },
        }

        try {
          const mod = (await server.ssrLoadModule('/api/chat.ts')) as {
            default: (request: unknown, response: unknown) => Promise<unknown>
          }
          await mod.default({ method: 'POST', body }, apiRes)
        } catch (error) {
          json(500, { error: error instanceof Error ? error.message : 'ошибка сервера' })
        }
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [react(), localApi(env)],
    server: {
      port: 5173,
    },
  }
})
