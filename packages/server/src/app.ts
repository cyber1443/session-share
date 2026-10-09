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
  HOST_HEADER,
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
  isHostCredential,
  loadAuthConfig,
  readInvite,
  readParticipantToken,
  readUserIdFromCookies,
  serverFingerprint,
  upsertPeerUser,
  upsertUser,
  type AuthConfig,
  type ParticipantClaims,
  type TokenFailure,
  type User,
} from './auth.js'
import { buildId } from './build.js'
import { Store } from './db.js'
import { ServiceError, SessionService, type AuthenticatedUser } from './service.js'
import { GitHubReader } from './github.js'
import { History } from './history.js'
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

/**
 * Why a participant token was not honoured. `reason` is the part to branch
 * on: the status alone cannot tell "this server never signed it" from "this
 * server signed it and has since lost what it named".
 */
const TOKEN_REFUSALS = {
  token_invalid: {
    status: 401,
    error: 'unauthorized',
    reason: 'token_invalid',
    message:
      'That token was not signed by this server -- it came from another server, or this one restarted with a new secret. Join again with a fresh invite.',
  },
  session_gone: {
    status: 404,
    error: 'not_found',
    reason: 'session_gone',
    message:
      'This server has no such session -- it was hosted somewhere else, or its database was reset. Ask for a fresh invite.',
  },
  seat_gone: {
    status: 404,
    error: 'not_found',
    reason: 'seat_gone',
    message: 'The seat this token was for is no longer in the session. Join again with the invite.',
  },
} as const

const OTHER_SESSION = {
  error: 'forbidden',
  reason: 'other_session',
  message: 'That token is for another session.',
} as const

type BearerCheck =
  | { ok: true; claims: ParticipantClaims }
  | ({ ok: false } & (typeof TOKEN_REFUSALS)[keyof typeof TOKEN_REFUSALS])
  | null

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
  machineId: z.string().min(1).max(100).nullish(),
})

const PeerJoinRequest = z.object({
  invite: z.string().min(1),
  githubLogin: z.string().min(1),
  displayName: z.string().min(1),
  /** Null when joining from a browser, which has no checkout to lease against. */
  repoPath: z.string().min(1).nullish(),
  /** Which machine the checkout is on; see Participant.machineId. */
  machineId: z.string().min(1).max(100).nullish(),
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
  /** Reads pull requests and Actions runs; injectable so a test never calls GitHub. */
  github?: GitHubReader
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
  const history = new History(store)
  const github = options.github ?? new GitHubReader()

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

  /**
   * The participant token on a request, and what is wrong with it if it cannot
   * be used. A token whose participant has gone is never a credential for an
   * empty chair -- but it used to read as no token at all, so a server that
   * had lost the session and one that had never signed the token both said
   * "sign in", and nothing on the other end could tell which fix it needed.
   * Each refusal now carries a `reason` a client can branch on.
   */
  const bearer = (request: FastifyRequest): BearerCheck => {
    const presented = request.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!presented) return null
    const claims = readParticipantToken(auth, presented)
    if (!claims) return { ok: false, ...TOKEN_REFUSALS.token_invalid }
    const state = service.state(claims.sessionId)
    if (!state.session) return { ok: false, ...TOKEN_REFUSALS.session_gone }
    if (!state.participants.has(claims.participantId)) return { ok: false, ...TOKEN_REFUSALS.seat_gone }
    return { ok: true, claims }
  }

  const bearerClaims = (request: FastifyRequest) => {
    const checked = bearer(request)
    return checked?.ok ? checked.claims : null
  }

  /**
   * Answers a request that had no usable credential: with what was wrong with
   * the token it presented, if it presented one, and otherwise with `fallback`.
   */
  const refuse = (
    request: FastifyRequest,
    reply: FastifyReply,
    fallback: { status: number; body: Record<string, unknown> },
  ) => {
    const checked = bearer(request)
    if (checked && !checked.ok) {
      return reply
        .code(checked.status)
        .send({ error: checked.error, reason: checked.reason, message: checked.message })
    }
    return reply.code(fallback.status).send(fallback.body)
  }

  /** A cookie is a browser's, and so is a token minted without a checkout. */
  const via = (claims: ParticipantClaims | null): 'board' | 'checkout' =>
    claims && !claims.board ? 'checkout' : 'board'

  /** Whoever runs this server. See hostCredential for why this is not an address check. */
  const isHost = (request: FastifyRequest) => isHostCredential(auth, request.headers[HOST_HEADER])

  const logIn = (reply: FastifyReply, user: User, redirectTo: string | null) => {
    reply.header('set-cookie', buildCookie(issueCookieValue(auth, user.id), auth.callbackUrl.startsWith('https://')))
    if (redirectTo) return reply.redirect(redirectTo)
    return reply.send({ user: toAuthUser(user) })
  }

  fastify.get('/healthz', async () => {
    const address = fastify.server.address()
    return {
      ok: true,
      mode: auth.mode,
      serverId: serverFingerprint(auth),
      // Which code is running, so a client can tell a stale daemon from a fresh one.
      build: buildId(),
      /**
       * Which process this is. A pid written to a file goes stale the moment the
       * process dies, and the OS hands it to something else -- so the only pid
       * worth signalling is the one the server reports about itself, right now.
       */
      pid: process.pid,
      host: address && typeof address === 'object' ? address.address : null,
    }
  })

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
   * an OAuth App. Gated on an explicit env flag AND a loopback socket with no
   * forwarder in front of it -- it must never be reachable from another machine.
   */
  fastify.post('/auth/dev', async (request, reply) => {
    if (!devLoginAllowed(auth, request.socket.remoteAddress ?? request.ip, request.headers)) {
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
    /**
     * A peer board has no cookie -- its credential is the participant token it
     * got from the invite. Reading only the cookie here left the board with no
     * idea who it was, so it could not tell which participant was itself: the
     * approve button and every "is this mine" check were dead in peer mode.
     */
    const claims = bearerClaims(request)
    const user = (claims ? store.findUserById(claims.userId) : null) ?? currentUser(request)

    return {
      mode: auth.mode,
      /**
       * `participantId` is the seat this token holds. One person can have a
       * seat per checkout, so "the participant with my user id" is ambiguous;
       * the token is not.
       */
      user: user ? { ...toAuthUser(user), participantId: claims?.participantId ?? null } : null,
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
    const claims = bearerClaims(request)
    if (claims) {
      // The socket inherits the token's reach: this session, this seat.
      return {
        ticket: issueWsTicket(auth, claims.userId, {
          sessionId: claims.sessionId,
          participantId: claims.participantId,
        }),
      }
    }

    const user = currentUser(request)
    if (!user) {
      return refuse(request, reply, {
        status: 401,
        body: { error: 'unauthorized', message: 'Sign in first.' },
      })
    }
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
      const claims = bearerClaims(request)
      if (!claims) {
        return refuse(request, reply, {
          status: 401,
          body: { error: 'unauthorized', message: 'Open the board with an invite link.' },
        })
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
          phase: state.phaseNow(),
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
     * Only the host opens sessions in peer mode. That used to mean "the request
     * came from loopback", which a tunnel on the host's machine satisfies for
     * every guest behind it -- so it is the host credential instead, which only
     * the host's own plugin can read off disk.
     */
    let user: User | null = null
    if (auth.mode === 'peer') {
      if (!isHost(request)) {
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
  /**
   * The session a read is for, once the caller has shown it may read it: a
   * signed-in browser, or a token for this very session. Answers the refusal
   * itself and returns null when it may not.
   */
  const readable = (request: FastifyRequest, reply: FastifyReply): SessionId | null => {
    const claims = bearerClaims(request)
    if (!claims && !currentUser(request)) {
      void refuse(request, reply, {
        status: 401,
        body: { error: 'unauthorized', message: 'Sign in first.' },
      })
      return null
    }

    const { ref } = request.params as { ref: string }
    const sessionId = store.findSessionIdByRef(ref)
    if (!sessionId) {
      const { error, reason, message } = TOKEN_REFUSALS.session_gone
      void reply.code(404).send({ error, reason, message })
      return null
    }
    if (claims && claims.sessionId !== sessionId) {
      void reply.code(403).send(OTHER_SESSION)
      return null
    }
    // Reading the session is being here: an agent that only polls is still present.
    if (claims) {
      if (via(claims) === 'checkout') service.worked(claims.participantId)
      else service.seen(claims.participantId)
    }
    return sessionId
  }

  fastify.get('/sessions/:ref/snapshot', async (request, reply) => {
    const sessionId = readable(request, reply)
    if (!sessionId) return reply
    return service.snapshotOf(sessionId)
  })

  /** What happened over the whole project, and what each person's Claude spent on it. */
  fastify.get('/sessions/:ref/history', async (request, reply) => {
    const sessionId = readable(request, reply)
    if (!sessionId) return reply
    return history.read(sessionId)
  })

  /** Open pull requests and recent Actions runs for the session's repository. */
  fastify.get('/sessions/:ref/github', async (request, reply) => {
    const sessionId = readable(request, reply)
    if (!sessionId) return reply
    const session = service.state(sessionId).session
    if (!session) return reply.code(404).send({ error: 'not_found' })
    return github.status(session.repo)
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
          machineId: parsed.data.machineId ?? null,
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
   * Anyone already in the session can pass it on -- that is the point -- but
   * "already in the session" has to be shown, not assumed: with no check here,
   * anyone who could guess a slug (it is the repository's name) could mint
   * themselves a way in. So it takes a seat in this session, or the host.
   */
  fastify.post('/api/sessions/:ref/invite', async (request, reply) => {
    const { ref } = request.params as { ref: string }
    const sessionId = store.findSessionIdByRef(ref)

    if (auth.mode === 'peer') {
      const claims = bearerClaims(request)
      const allowed = isHost(request) || (claims !== null && claims.sessionId === sessionId)
      if (!allowed) {
        return refuse(request, reply, {
          status: 403,
          body: {
            error: 'forbidden',
            message: 'Only someone already in this session, or its host, can invite people to it.',
          },
        })
      }
    } else {
      const user = requireUser(request, reply)
      if (!user) return
    }
    if (!sessionId) return reply.code(404).send({ error: 'not_found' })

    const state = service.state(sessionId)
    return {
      invite: issueInvite(auth, sessionId),
      sessionRef: state.session?.slug ?? ref,
      sessionTitle: state.session?.title ?? ref,
      // So a host resuming by slug can tell its own session from a namesake's.
      repo: state.session?.repo ?? null,
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

    const checked = readInvite(auth, parsed.data.invite)
    if (!checked.ok) return reply.code(401).send(inviteRefusal(checked, serverFingerprint(auth)))
    const claims = checked.claims

    const state = service.state(claims.sessionId)
    if (!state.session) return reply.code(404).send({ error: 'not_found' })

    // Recorded like any other user so presence, ws tickets and rejoins all work
    // the same; the difference is only that nothing verified this name.
    const record = upsertPeerUser(store, {
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
          machineId: parsed.data.machineId ?? null,
          fromSeq: null,
        },
        {
          sessionId: claims.sessionId,
          participantId: null,
          user,
          via: parsed.data.repoPath ? 'checkout' : 'board',
        },
      )

      return {
        participantId: result.participantId,
        participantToken: issueParticipantToken(auth, {
          participantId: result.participantId,
          sessionId: claims.sessionId,
          userId: user.id,
          ...(parsed.data.repoPath ? {} : { board: true }),
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

    const { command } = parsed.data

    /**
     * Sessions are opened through POST /api/sessions, which is where the rule
     * about who may open one lives. Accepting the command here as well would
     * let any seat in any session open new ones.
     */
    if (command.type === 'session.create') {
      return reply.code(403).send({
        error: 'forbidden',
        message: 'Open a session with POST /api/sessions.',
      })
    }

    const claims = bearerClaims(request)

    let sessionId: SessionId | null = null
    let participantId: ParticipantId | null = null
    let user: AuthenticatedUser | null = null

    if (claims) {
      /**
       * A participant token is for one session. Every way a request can name
       * a session -- the envelope's sessionRef, or a join's own -- has to agree
       * with it, or the token for one session opens every other.
       */
      const named = [parsed.data.sessionRef, command.type === 'session.join' ? command.sessionRef : null]
      for (const ref of named) {
        if (!ref) continue
        if (store.findSessionIdByRef(ref) !== claims.sessionId) {
          return reply.code(403).send(OTHER_SESSION)
        }
      }
      sessionId = claims.sessionId
      participantId = claims.participantId
      const record = store.findUserById(claims.userId)
      if (!record) return reply.code(401).send({ error: 'unauthorized', message: 'Unknown user.' })
      user = toAuthUser(record)
    } else {
      const record = currentUser(request)
      if (!record) {
        return refuse(request, reply, {
          status: 401,
          body: {
            error: 'unauthorized',
            message: 'Sign in, or attach this checkout with /ss:join <code>.',
          },
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
      const data = service.handle(command as never, {
        sessionId,
        participantId,
        user,
        via: via(claims),
      })
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

/**
 * What to tell someone whose invite was refused. Each reason has a different
 * fix, and the commonest one -- the wrong server -- is the one the server can
 * least explain on its own, so it names itself for the client to compare.
 */
function inviteRefusal(
  checked: { reason: TokenFailure; expiredAt?: number },
  serverId: string,
) {
  switch (checked.reason) {
    case 'expired':
      return {
        error: 'unauthorized',
        reason: 'expired',
        message:
          `That invite expired${checked.expiredAt ? ` on ${new Date(checked.expiredAt).toISOString().slice(0, 10)}` : ''}. ` +
          'Ask whoever sent it for a fresh one -- /ss:board or /ss:host on their side mints a new link.',
        serverId,
      }
    case 'malformed':
      return {
        error: 'unauthorized',
        reason: 'malformed',
        message:
          'That invite is damaged -- most likely it was cut short or wrapped when it was copied. Ask for it again.',
        serverId,
      }
    case 'signature':
      /**
       * Nearly always this is not a bad token but the wrong server: the address
       * inside the invite resolved to the guest's own machine. Say so, because
       * from here "invalid" and "not mine" look identical.
       */
      return {
        error: 'unauthorized',
        reason: 'signature',
        message:
          `That invite was not signed by this server (${serverId}). ` +
          'If a teammate sent it, the address inside it is pointing at your own machine -- ' +
          'ask them to re-run /ss:host so the invite carries their network address.',
        serverId,
      }
  }
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1
  return counts
}
