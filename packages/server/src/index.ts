import { createApp } from './app.js'

export { createApp } from './app.js'
export { SessionService, ServiceError } from './service.js'
export { SessionState, CLAIM_CAP } from './projection.js'
export { Store } from './db.js'

const isEntrypoint = process.argv[1]?.endsWith('index.js') ?? false

if (isEntrypoint) {
  const port = Number(process.env.PORT ?? 4310)
  const host = process.env.HOST ?? '127.0.0.1'
  const app = createApp({
    dbPath: process.env.SESSION_SHARE_DB ?? '.data/session-share.db',
    logger: true,
  })

  const shutdown = async () => {
    await app.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  const address = await app.listen(port, host)
  app.fastify.log.info(`session-share coordination server on ${address} (ws at ${address}/ws)`)
}
