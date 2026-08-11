import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import fastifyStatic from '@fastify/static'
import { z } from 'zod'
import {
  ClientCommand,
  RepoRef,
  type ErrorCode,
  type ParticipantId,
  type SessionId,
} from '@session-share/protocol'
import {
  JOIN_TOKEN_TTL_MS,
  buildCookie,
  clearCookie,
  devLoginAllowed,
  exchangeGithubCode,
  fetchGithubUser,
  generateJoinToken,
  githubAuthorizeUrl,
  issueCookieValue,
  issueInvite,
  issueParticipantToken,
  issueWsTicket,
  loadAuthConfig,
  peerUserId,
  readInvite,
  readParticipantToken,
  readUserIdFromCookies,
  upsertUser,
  type AuthConfig,
  type User,
} from './auth.js'
import { Store } from './db.js'
import { ServiceError, SessionService, type AuthenticatedUser } from './service.js'
import { Gateway } from './ws.js'

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  not_ready: 409,
  internal: 500,
}

const OneShotRequest = z.object({
  /** Only needed when authenticating by cookie; a participant token carries it. */
  sessionRef: z.string().min(1).nullish(),
  command: ClientCommand,
})

const CreateSessionRequest = z.object({
  slug: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'slug must be lowercase kebab-case'),
  title: z.string().min(1).max(120),
  repo: RepoRef,
  issueRef: z.string().nullish(),
})

const JoinRequest = z.object({
  token: z.string().min(1),
  repoPath: z.string().min(1),
})

const PeerJoinRequest = z.object({
  invite: z.string().min(1),
  githubLogin: z.string().min(1),
  displayName: z.string().min(1),
  /** Null when joining from a browser, which has no checkout to lease against. */
  repoPath: z.string().min(1).nullish(),
})

export interface AppOptions {
  dbPath?: string
  logger?: boolean
  auth?: Partial<AuthConfig>
  /**
   * Directory of the exported board. When present the server serves the UI too,
   * so a session is one process on one port instead of two things to start and
   * a proxy between them.
   */
  webRoot?: string | null
}

export interface App {
  fastify: FastifyInstance
  service: SessionService
  gateway: Gateway
  store: Store
  auth: AuthConfig
  webRoot: string | null
  listen(port: number, host?: string): Promise<string>
  close(): Promise<void>
}

/** The board as exported by `pnpm --filter @session-share/web build`. */
function defaultWebRoot(): string | null {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    process.env.SESSION_SHARE_WEB_ROOT,
    // Packaged: the board is vendored next to the server's own dist.
    resolve(here, '../web'),
    // In the monorepo: packages/server/dist -> apps/web/out.
    resolve(here, '../../../apps/web/out'),
  ].filter((value): value is string => Boolean(value))
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

export function createApp(options: AppOptions = {}): App {
  const auth = { ...loadAuthConfig(), ...options.auth }
  const store = new Store(options.dbPath ?? '.data/session-share.db')
  const fastify = Fastify({ logger: options.logger ?? false })
  const gateway = new Gateway(fastify.server, '/ws', auth, store)
  const service = new SessionService(
    store,
    (sessionId, envelope) => gateway.broadcast(sessionId, envelope),
    (sessionId, from, frame) => gateway.relayFrame(sessionId, from, frame),
  )
  gateway.attach(service)

  const toAuthUser = (user: User): AuthenticatedUser => ({
    id: user.id,
    githubLogin: user.githubLogin,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
  })

  const currentUser = (request: FastifyRequest): User | null => {
    const userId = readUserIdFromCookies(auth, request.headers.cookie)
    return userId ? store.findUserById(userId) : null
  }

  const requireUser = (request: FastifyRequest, reply: FastifyReply): User | null => {
    const user = currentUser(request)
    if (!user) {
      reply.code(401).send({ error: 'unauthorized', message: 'Sign in first.' })
      return null
    }
    return user
  }

  const logIn = (reply: FastifyReply, user: User, redirectTo: string | null) => {
    reply.header('set-cookie', buildCookie(issueCookieValue(auth, user.id), auth.callbackUrl.startsWith('https://')))
    if (redirectTo) return reply.redirect(redirectTo)
    return reply.send({ user: toAuthUser(user) })
  }

  fastify.get('/healthz', async () => ({ ok: true }))

  // -- sign in -------------------------------------------------------------

  fastify.get('/auth/github', async (request, reply) => {
    if (!auth.githubClientId) {
      return reply.code(503).send({
        error: 'not_configured',
        message:
          'GITHUB_CLIENT_ID is not set. Register an OAuth App, or start the server with SESSION_SHARE_DEV_LOGIN=1 to sign in locally without one.',
      })
    }
    const { redirect_to: redirectTo } = request.query as { redirect_to?: string }
    const state = randomUUID()
    store.createOauthState(state, redirectTo ?? '/', Date.now())
    return reply.redirect(githubAuthorizeUrl(auth, state))
  })

  fastify.get('/auth/github/callback', async (request, reply) => {
    const { code, state } = request.query as { code?: string; state?: string }
    if (!code || !state) {
      return reply.code(400).send({ error: 'bad_request', message: 'Missing code or state.' })
    }

    const stored = store.consumeOauthState(state)
    if (!stored) {
      return reply.code(400).send({ error: 'bad_request', message: 'Unknown or reused state.' })
    }

    try {
      const accessToken = await exchangeGithubCode(auth, code)
      const profile = await fetchGithubUser(accessToken)
      const user = upsertUser(store, profile)
      return logIn(reply, user, stored.redirectTo ?? '/')
    } catch (error) {
      return reply
        .code(502)
        .send({ error: 'internal', message: error instanceof Error ? error.message : 'oauth failed' })
    }
  })

  /**
   * Local-only shortcut so the whole flow is testable before anyone registers
   * an OAuth App. Gated on an explicit env flag AND a loopback Host header --
   * it must never be reachable from another machine.
   */
  fastify.post('/auth/dev', async (request, reply) => {
    if (!devLoginAllowed(auth, request.socket.remoteAddress ?? request.ip)) {
      return reply.code(404).send({ error: 'not_found' })
    }
    const { login } = (request.body ?? {}) as { login?: string }
    if (!login) return reply.code(400).send({ error: 'bad_request', message: 'login required' })

    const user = upsertUser(store, {
      githubId: `dev:${login}`,
      githubLogin: login,
      displayName: login[0]!.toUpperCase() + login.slice(1),
      avatarUrl: null,
    })
    return logIn(reply, user, null)
  })

  fastify.post('/auth/logout', async (_request, reply) => {
    reply.header('set-cookie', clearCookie())
    return { ok: true }
  })

  /** Answers for signed-out callers too: the login page needs to know what it can offer. */
  fastify.get('/api/me', async (request) => {
    const user = currentUser(request)
    return {
      mode: auth.mode,
      user: user ? toAuthUser(user) : null,
      devLogin: auth.devLogin,
      githubConfigured: Boolean(auth.githubClientId),
    }
  })

  /**
   * Cookies do not survive a cross-origin WebSocket, so the board trades one in.
   * A peer-mode board has no cookie at all and presents its participant token
   * instead -- same exchange, different credential.
   */
  fastify.get('/api/ws-ticket', async (request, reply) => {
    const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, '')
    const claims = bearer ? readParticipantToken(auth, bearer) : null
    if (claims) return { ticket: issueWsTicket(auth, claims.userId) }

    const user = requireUser(request, reply)
    if (!user) return
    return { ticket: issueWsTicket(auth, user.id) }
  })

  // -- sessions ------------------------------------------------------------

  fastify.get('/api/sessions', async (request, reply) => {
    /**
     * In peer mode there is no account to scope a listing to, so the invite
     * does it: you see the session your token is for and nothing else. Handing
     * every caller the full list of a machine's sessions would leak them.
     */
    let visible: SessionId[] | null = null
    let user: User | null = null

    if (auth.mode === 'peer') {
      const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, '')
      const claims = bearer ? readParticipantToken(auth, bearer) : null
      if (!claims) {
        return reply
          .code(401)
          .send({ error: 'unauthorized', message: 'Open the board with an invite link.' })
      }
      visible = [claims.sessionId]
    } else {
      user = requireUser(request, reply)
      if (!user) return
    }

    const sessions = (visible ?? store.listSessionIds()).flatMap((id) => {
      const state = service.state(id)
      if (!state.session) return []
      return [
        {
          id: state.session.id,
          slug: state.session.slug,
          title: state.session.title,
          phase: state.session.phase,
          repo: state.session.repo,
          issueRef: state.session.issueRef,
          createdAt: state.session.createdAt,
          participants: [...state.participants.values()].map((p) => ({
            id: p.id,
            displayName: p.displayName,
            avatarUrl: p.avatarUrl,
            connected: p.connected,
            colorIndex: p.colorIndex,
          })),
          mine: user ? [...state.participants.values()].some((p) => p.userId === user.id) : true,
          taskCounts: countBy([...state.tasks.values()].map((t) => t.state)),
        },
      ]
    })
    return { sessions }
  })

  fastify.post('/api/sessions', async (request, reply) => {
    /**
     * Only the host opens sessions in peer mode, and the host is by definition
     * the machine the server runs on -- so loopback is the check. Guests arrive
     * through a tunnel or the LAN and cannot create anything.
     */
    let user: User | null = null
    if (auth.mode === 'peer') {
      if (!isLoopbackRequest(request)) {
        return reply.code(403).send({
          error: 'forbidden',
          message: 'Only the machine hosting this session can create one.',
        })
      }
    } else {
      user = requireUser(request, reply)
      if (!user) return
    }

    const parsed = CreateSessionRequest.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', message: parsed.error.message })
    }

    try {
      const created = service.handle(
        { type: 'session.create', ...parsed.data, issueRef: parsed.data.issueRef ?? null },
        { sessionId: null, participantId: null, user: user ? toAuthUser(user) : null },
      )
      return {
        ...created,
        // Peer sessions are useless without the string that lets someone in.
        invite: auth.mode === 'peer' ? issueInvite(auth, created.sessionId) : null,
      }
    } catch (error) {
      return sendServiceError(reply, error)
    }
  })

  /** Readable by a signed-in user or by an attached checkout's participant token. */
  fastify.get('/sessions/:ref/snapshot', async (request, reply) => {
    const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, '')
    const claims = bearer ? readParticipantToken(auth, bearer) : null
    if (!claims && !currentUser(request)) {
      return reply.code(401).send({ error: 'unauthorized', message: 'Sign in first.' })
    }

    const { ref } = request.params as { ref: string }
    const sessionId = store.findSessionIdByRef(ref)
    if (!sessionId) return reply.code(404).send({ error: 'not_found' })
    if (claims && claims.sessionId !== sessionId) {
      return reply.code(403).send({ error: 'forbidden', message: 'That token is for another session.' })
    }
    return service.state(sessionId).snapshot()
  })

  // -- pairing a checkout --------------------------------------------------

  /**
   * Mints the string a developer pastes into /ss:join. Single use, 15 minutes,
   * and bound to this user and this session -- so a copy left in shell history
   * is worth nothing once it has been spent.
   */
  fastify.post('/api/sessions/:ref/join-token', async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) return

    const { ref } = request.params as { ref: string }
    const sessionId = store.findSessionIdByRef(ref)
    if (!sessionId) return reply.code(404).send({ error: 'not_found' })

    const token = generateJoinToken()
    const expiresAt = Date.now() + JOIN_TOKEN_TTL_MS
    store.createJoinToken(token, user.id, sessionId, expiresAt)
    return { token, expiresAt, command: `/ss:join ${token}` }
  })

  /** The plugin's half of the pairing: token in, long-lived participant token out. */
  fastify.post('/api/join', async (request, reply) => {
    const parsed = JoinRequest.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', message: parsed.error.message })
    }

    const redeemed = store.redeemJoinToken(parsed.data.token, Date.now())
    if (!redeemed) {
      return reply.code(401).send({
        error: 'unauthorized',
        message: 'That join code is expired or has already been used. Generate a fresh one.',
      })
    }

    const user = store.findUserById(redeemed.userId)
    if (!user) return reply.code(401).send({ error: 'unauthorized' })

    const state = service.state(redeemed.sessionId)
    if (!state.session) return reply.code(404).send({ error: 'not_found' })

    try {
      const result = service.handle(
        {
          type: 'session.join',
          sessionRef: state.session.slug,
          githubLogin: user.githubLogin,
          displayName: user.displayName,
          repoPath: parsed.data.repoPath,
          fromSeq: null,
        },
        { sessionId: redeemed.sessionId, participantId: null, user: toAuthUser(user) },
      )

      return {
        participantId: result.participantId,
        participantToken: issueParticipantToken(auth, {
          participantId: result.participantId,
          sessionId: redeemed.sessionId,
          userId: user.id,
        }),
        sessionRef: state.session.slug,
        sessionTitle: state.session.title,
        displayName: user.displayName,
        githubLogin: user.githubLogin,
      }
    } catch (error) {
      return sendServiceError(reply, error)
    }
  })

  // -- peer mode -----------------------------------------------------------

  /**
   * Mints the string that IS the session in peer mode: it names the session and
   * is signed by this server, so holding it is what makes you a participant.
   * Anyone already in the session can pass it on -- that is the point.
   */
  fastify.post('/api/sessions/:ref/invite', async (request, reply) => {
    if (auth.mode !== 'peer') {
      const user = requireUser(request, reply)
      if (!user) return
    }
    const { ref } = request.params as { ref: string }
    const sessionId = store.findSessionIdByRef(ref)
    if (!sessionId) return reply.code(404).send({ error: 'not_found' })

    const state = service.state(sessionId)
    return {
      invite: issueInvite(auth, sessionId),
      sessionRef: state.session?.slug ?? ref,
      sessionTitle: state.session?.title ?? ref,
    }
  })

  /**
   * The peer counterpart of the OAuth + join-code dance: one call, no login, no
   * registered application. The invite proves membership; the name is taken on
   * trust from the caller's own machine.
   */
  fastify.post('/api/peer/join', async (request, reply) => {
    if (auth.mode !== 'peer') {
      return reply
        .code(404)
        .send({ error: 'not_found', message: 'This server verifies identity with GitHub.' })
    }

    const parsed = PeerJoinRequest.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', message: parsed.error.message })
    }

    const claims = readInvite(auth, parsed.data.invite)
    if (!claims) {
      return reply
        .code(401)
        .send({ error: 'unauthorized', message: 'That invite is not valid for this server.' })
    }

    const state = service.state(claims.sessionId)
    if (!state.session) return reply.code(404).send({ error: 'not_found' })

    // Recorded like any other user so presence, ws tickets and rejoins all work
    // the same; the difference is only that nothing verified this name.
    const record = upsertUser(store, {
      githubId: peerUserId(parsed.data.githubLogin),
      githubLogin: parsed.data.githubLogin,
      displayName: parsed.data.displayName,
      avatarUrl: null,
    })
    const user: AuthenticatedUser = toAuthUser(record)

    try {
      const result = service.handle(
        {
          type: 'session.join',
          sessionRef: state.session.slug,
          githubLogin: user.githubLogin,
          displayName: user.displayName,
          repoPath: parsed.data.repoPath ?? null,
          fromSeq: null,
        },
        { sessionId: claims.sessionId, participantId: null, user },
      )

      return {
        participantId: result.participantId,
        participantToken: issueParticipantToken(auth, {
          participantId: result.participantId,
          sessionId: claims.sessionId,
          userId: user.id,
        }),
        sessionRef: state.session.slug,
        sessionTitle: state.session.title,
        displayName: user.displayName,
        githubLogin: user.githubLogin,
      }
    } catch (error) {
      return sendServiceError(reply, error)
    }
  })

  // -- commands ------------------------------------------------------------

  /**
   * One-shot command endpoint for short-lived callers -- above all the
   * PreToolUse hook, which is a fresh process on every edit and cannot hold a
   * socket. Same handlers, same events, same broadcast; only the transport
   * differs.
   */
  fastify.post('/api/commands', async (request, reply) => {
    const parsed = OneShotRequest.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', message: parsed.error.message })
    }

    const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, '')
    const claims = bearer ? readParticipantToken(auth, bearer) : null

    let sessionId: SessionId | null = null
    let participantId: ParticipantId | null = null
    let user: AuthenticatedUser | null = null

    if (claims) {
      sessionId = claims.sessionId
      participantId = claims.participantId
      const record = store.findUserById(claims.userId)
      user = record ? toAuthUser(record) : null
    } else {
      const record = currentUser(request)
      if (!record) {
        return reply.code(401).send({
          error: 'unauthorized',
          message: 'Sign in, or attach this checkout with /ss:join <code>.',
        })
      }
      user = toAuthUser(record)
      if (parsed.data.sessionRef) {
        sessionId = store.findSessionIdByRef(parsed.data.sessionRef)
        if (!sessionId) return reply.code(404).send({ error: 'not_found' })
        participantId =
          [...service.state(sessionId).participants.values()].find((p) => p.userId === record.id)
            ?.id ?? null
      }
    }

    try {
      const data = service.handle(parsed.data.command as never, { sessionId, participantId, user })
      return { data }
    } catch (error) {
      return sendServiceError(reply, error)
    }
  })

  // Registered last so it can never shadow an API route.
  const webRoot = options.webRoot ?? defaultWebRoot()
  if (webRoot && existsSync(webRoot)) {
    fastify.register(fastifyStatic, { root: webRoot })
    // The board is a client-rendered app: unknown paths are its routes, not 404s.
    fastify.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/') || request.url.startsWith('/auth/')) {
        return reply.code(404).send({ error: 'not_found' })
      }
      return reply.sendFile('index.html')
    })
  }

  return {
    fastify,
    service,
    gateway,
    store,
    auth,
    webRoot: webRoot && existsSync(webRoot) ? webRoot : null,
    async listen(port, host = '127.0.0.1') {
      return fastify.listen({ port, host })
    },
    async close() {
      await gateway.close()
      await fastify.close()
      store.close()
    },
  }
}

function sendServiceError(reply: FastifyReply, error: unknown) {
  if (error instanceof ServiceError) {
    return reply.code(STATUS[error.code]).send({ error: error.code, message: error.message })
  }
  throw error
}

/**
 * Derived from the socket, never from the Host header -- a remote caller can
 * put anything in a header, so trusting one here would make "only this machine"
 * mean "only callers who claim to be this machine".
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false
  const normalised = address.replace(/^::ffff:/, '')
  return normalised === '127.0.0.1' || normalised === '::1' || normalised.startsWith('127.')
}

function isLoopbackRequest(request: FastifyRequest): boolean {
  return isLoopbackAddress(request.socket.remoteAddress ?? request.ip)
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1
  return counts
}
