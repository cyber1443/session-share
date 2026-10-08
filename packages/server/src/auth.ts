import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { ParticipantId, SessionId } from '@session-share/protocol'
import type { Store } from './db.js'

export interface User {
  id: string
  githubId: string
  githubLogin: string
  displayName: string
  avatarUrl: string | null
}

/**
 * `oauth` verifies who someone is against GitHub, which is what a shared
 * deployment needs. `peer` trusts whoever holds the invite and takes their name
 * from their own machine -- the right trade for two people who can hand each
 * other a link, and the wrong one for a public URL.
 */
export type AuthMode = 'oauth' | 'peer'

export interface AuthConfig {
  mode: AuthMode
  /** Signs cookies, invites, participant tokens and ws tickets. */
  secret: string
  githubClientId: string | null
  githubClientSecret: string | null
  /** Where GitHub sends the user back; must match the OAuth App exactly. */
  callbackUrl: string
  /**
   * Loopback-only login for local development, so the whole flow is testable
   * before anyone registers an OAuth App. Refused on any non-loopback bind.
   */
  devLogin: boolean
}

export const JOIN_TOKEN_TTL_MS = 15 * 60 * 1000
const WS_TICKET_TTL_MS = 60 * 1000
const COOKIE_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const SESSION_COOKIE = 'ss_session'

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/** `<base64url(json)>.<hmac>` -- compact, stateless, and tamper-evident. */
export function encodeToken(secret: string, claims: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${body}.${sign(secret, body)}`
}

/**
 * Why a token was refused. These are three different conversations with the
 * person holding it -- "ask for a fresh one", "you reached the wrong server",
 * "it got mangled in the copy" -- and collapsing them into one null is how an
 * invite that had simply aged out got reported as the wrong machine.
 */
export type TokenFailure = 'malformed' | 'signature' | 'expired'

export type TokenCheck<T> =
  | { ok: true; claims: T }
  | { ok: false; reason: TokenFailure; expiredAt?: number }

export function verifyToken<T>(secret: string, token: string): TokenCheck<T> {
  const [body, signature, ...rest] = token.split('.')
  if (!body || !signature || rest.length > 0) return { ok: false, reason: 'malformed' }
  if (!safeEqual(signature, sign(secret, body))) return { ok: false, reason: 'signature' }
  let claims: T & { exp?: number }
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T & { exp?: number }
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (typeof claims.exp === 'number' && claims.exp < Date.now()) {
    return { ok: false, reason: 'expired', expiredAt: claims.exp }
  }
  return { ok: true, claims }
}

export function decodeToken<T>(secret: string, token: string): T | null {
  const checked = verifyToken<T>(secret, token)
  return checked.ok ? checked.claims : null
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

export interface SessionCookieClaims {
  userId: string
  exp: number
}

export function issueCookieValue(config: AuthConfig, userId: string): string {
  return encodeToken(config.secret, { userId, exp: Date.now() + COOKIE_TTL_MS })
}

export function readUserIdFromCookies(config: AuthConfig, header: string | undefined): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name !== SESSION_COOKIE) continue
    const claims = decodeToken<SessionCookieClaims>(config.secret, decodeURIComponent(rest.join('=')))
    return claims?.userId ?? null
  }
  return null
}

export function buildCookie(value: string, secure: boolean): string {
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(COOKIE_TTL_MS / 1000)}`,
  ]
  if (secure) attrs.push('Secure')
  return attrs.join('; ')
}

export function clearCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
}

// ---------------------------------------------------------------------------
// Tokens the plugin and the board carry
// ---------------------------------------------------------------------------

export interface ParticipantClaims {
  kind: 'participant'
  participantId: ParticipantId
  sessionId: SessionId
  userId: string
  /**
   * Set on a token minted for a browser, which has no checkout. It may sit in
   * a checkout's seat, but what it sends is someone watching, not the
   * checkout working -- see SessionService.isWorking. Absent on every token
   * minted before the distinction, all of which were checkouts' own.
   */
  board?: boolean
}

export interface WsTicketClaims {
  kind: 'ws'
  userId: string
  /**
   * Set when the ticket was traded for a participant token. A token is for one
   * session and one seat in it, and a socket opened with it must stay there --
   * otherwise the token for session A is a key to every session on the server.
   */
  sessionId?: SessionId | null
  participantId?: ParticipantId | null
  exp: number
}

export function issueParticipantToken(config: AuthConfig, claims: Omit<ParticipantClaims, 'kind'>): string {
  return encodeToken(config.secret, { ...claims, kind: 'participant' })
}

export function readParticipantToken(config: AuthConfig, token: string): ParticipantClaims | null {
  const claims = decodeToken<ParticipantClaims>(config.secret, token)
  return claims?.kind === 'participant' ? claims : null
}

export function issueWsTicket(
  config: AuthConfig,
  userId: string,
  bound: { sessionId: SessionId; participantId: ParticipantId } | null = null,
): string {
  return encodeToken(config.secret, {
    kind: 'ws',
    userId,
    ...(bound ? { sessionId: bound.sessionId, participantId: bound.participantId } : {}),
    exp: Date.now() + WS_TICKET_TTL_MS,
  })
}

export function readWsTicket(config: AuthConfig, ticket: string): TokenCheck<WsTicketClaims> {
  const checked = verifyToken<WsTicketClaims>(config.secret, ticket)
  if (checked.ok && checked.claims.kind !== 'ws') return { ok: false, reason: 'signature' }
  return checked
}

// ---------------------------------------------------------------------------
// Join tokens: one-time, short-lived, exchanged for a participant token
// ---------------------------------------------------------------------------

/**
 * Deliberately single-use and short-lived. It is meant to be pasted into a
 * terminal, so it will end up in shell history -- a spent token in a history
 * file is worth nothing to anyone.
 */
export function generateJoinToken(): string {
  return `ssj_${randomBytes(18).toString('base64url')}`
}

export interface JoinTokenRow {
  token: string
  userId: string
  sessionId: SessionId
  expiresAt: number
  usedAt: number | null
}

// ---------------------------------------------------------------------------
// Invites: the whole of peer mode's trust model
// ---------------------------------------------------------------------------

export interface InviteClaims {
  kind: 'invite'
  sessionId: SessionId
  exp: number
}

/**
 * Long-lived on purpose. An invite is the session -- you paste it once to join
 * and once more per extra checkout -- so an expiry measured in minutes would
 * just mean re-minting it constantly for no security gain, given that anyone
 * who can read it could have joined at any point anyway.
 */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000

export function issueInvite(config: AuthConfig, sessionId: SessionId): string {
  return encodeToken(config.secret, {
    kind: 'invite',
    sessionId,
    exp: Date.now() + INVITE_TTL_MS,
  })
}

export function readInvite(config: AuthConfig, invite: string): TokenCheck<InviteClaims> {
  const checked = verifyToken<InviteClaims>(config.secret, invite.trim())
  if (checked.ok && checked.claims.kind !== 'invite') return { ok: false, reason: 'malformed' }
  return checked
}

/**
 * In peer mode a participant's name comes from their own machine and is not
 * checked against anything. That is the deal: the invite is the credential, and
 * the names exist so humans can tell each other apart, not to prove anything.
 *
 * Not case-folded. A peer handle is often derived from git's user.name, where
 * "Sam-Lee" and "sam-lee" are two different people far more often than they
 * are one person typing inconsistently, and folding them merged their seats.
 */
export function peerUserId(githubLogin: string): string {
  return `peer:${githubLogin}`
}

/**
 * Finds or creates the record for a peer handle, carrying over one written by
 * an older server. Those folded the handle to lower case, so "AnesMehagic"
 * was stored as `peer:anesmehagic` -- and looking only under the exact handle
 * after an upgrade made a new user for the same person, whose old seat still
 * held the lead and the leases while the new one was refused its own checkout
 * as somebody else's.
 *
 * The folded record is only taken over when the login it last recorded is
 * this exact handle. That is the case-sensitive name the person actually
 * typed, so "Sam-Lee" does not inherit a record "sam-lee" left behind. Once
 * taken over it is re-keyed under the exact handle, so the folded id is free
 * again and this lookup only ever happens once.
 */
export function upsertPeerUser(store: Store, profile: Omit<User, 'id' | 'githubId'>): User {
  const githubId = peerUserId(profile.githubLogin)
  if (!store.findUserByGithubId(githubId)) {
    const folded = peerUserId(profile.githubLogin.toLowerCase())
    const legacy = folded === githubId ? null : store.findUserByGithubId(folded)
    if (legacy && legacy.githubLogin === profile.githubLogin) store.rekeyUser(legacy.id, githubId)
  }
  return upsertUser(store, { ...profile, githubId })
}

/**
 * The credential that marks a request as coming from the person hosting this
 * server: opening sessions, minting invites without a seat of their own.
 *
 * This used to be the socket address -- loopback meant "the host". That stops
 * being true the moment anyone runs a tunnel: cloudflared and friends connect
 * from 127.0.0.1, so every guest arriving through one looked local. A secret
 * derived from the signing key is something only the host's own machine can
 * produce, whatever route the request took. It is derived rather than the key
 * itself so the header can never be replayed as a signing secret.
 */
export const HOST_HEADER = 'x-session-share-host'

export function hostCredential(config: AuthConfig): string {
  return createHmac('sha256', config.secret).update('session-share/host-key').digest('hex')
}

export function isHostCredential(config: AuthConfig, presented: string | string[] | undefined): boolean {
  if (typeof presented !== 'string' || !presented) return false
  return safeEqual(presented, hostCredential(config))
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

export function githubAuthorizeUrl(config: AuthConfig, state: string): string {
  if (!config.githubClientId) throw new Error('GITHUB_CLIENT_ID is not set')
  const url = new URL('https://github.com/login/oauth/authorize')
  url.searchParams.set('client_id', config.githubClientId)
  url.searchParams.set('redirect_uri', config.callbackUrl)
  url.searchParams.set('scope', 'read:user')
  url.searchParams.set('state', state)
  return url.toString()
}

export async function exchangeGithubCode(config: AuthConfig, code: string): Promise<string> {
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: config.githubClientId,
      client_secret: config.githubClientSecret,
      code,
      redirect_uri: config.callbackUrl,
    }),
  })
  const payload = (await response.json()) as { access_token?: string; error_description?: string }
  if (!payload.access_token) {
    throw new Error(payload.error_description ?? 'GitHub refused the code exchange')
  }
  return payload.access_token
}

export async function fetchGithubUser(accessToken: string): Promise<Omit<User, 'id'>> {
  const response = await fetch('https://api.github.com/user', {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'session-share',
    },
  })
  if (!response.ok) throw new Error(`GitHub user lookup failed: ${response.status}`)
  const user = (await response.json()) as {
    id: number
    login: string
    name: string | null
    avatar_url: string | null
  }
  return {
    githubId: String(user.id),
    githubLogin: user.login,
    displayName: user.name ?? user.login,
    avatarUrl: user.avatar_url,
  }
}

/** Finds or creates the local user record for a GitHub identity. */
export function upsertUser(store: Store, profile: Omit<User, 'id'>): User {
  const existing = store.findUserByGithubId(profile.githubId)
  if (existing) {
    const updated = { ...existing, ...profile }
    store.saveUser(updated)
    return updated
  }
  const user: User = { id: randomUUID(), ...profile }
  store.saveUser(user)
  return user
}

/**
 * A public, non-reversible name for this server's signing key. Two servers with
 * different secrets cannot honour each other's invites, so publishing the
 * fingerprint lets a client work out *which* server it reached before it tries.
 */
export function serverFingerprint(config: AuthConfig): string {
  return createHmac('sha256', config.secret).update('session-share/server-id').digest('hex').slice(0, 16)
}

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const githubClientId = env.GITHUB_CLIENT_ID ?? null
  return {
    // Registering an OAuth App is the opt-in to verified identity. Without one,
    // the server runs in peer mode rather than refusing to start.
    mode: (env.SESSION_SHARE_MODE as AuthMode | undefined) ?? (githubClientId ? 'oauth' : 'peer'),
    secret: env.SESSION_SHARE_SECRET ?? randomBytes(32).toString('hex'),
    githubClientId,
    githubClientSecret: env.GITHUB_CLIENT_SECRET ?? null,
    callbackUrl: env.GITHUB_CALLBACK_URL ?? 'http://127.0.0.1:3000/auth/github/callback',
    devLogin: env.SESSION_SHARE_DEV_LOGIN === '1',
  }
}

/**
 * Headers a reverse proxy or tunnel adds on the way through. Their *values* are
 * attacker-controlled and prove nothing, but their presence is a reliable sign
 * that the loopback socket belongs to a forwarder rather than to someone on
 * this machine.
 */
const FORWARDED_HEADERS = [
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-real-ip',
  'cf-connecting-ip',
  'true-client-ip',
]

/**
 * Dev login is a backdoor; it must never be reachable off the machine. The
 * check is on the connecting socket, not on the Host header -- a header is
 * attacker-controlled, so gating on one would gate on nothing. A loopback
 * socket alone is not enough either: a tunnel on this machine connects from
 * loopback on behalf of whoever is at the other end, so anything that arrived
 * through a forwarder is refused too.
 */
export function devLoginAllowed(
  config: Pick<AuthConfig, 'devLogin'>,
  remoteAddress: string | undefined,
  headers: Record<string, string | string[] | undefined> = {},
): boolean {
  if (!config.devLogin) return false
  if (!remoteAddress) return false
  if (FORWARDED_HEADERS.some((name) => headers[name] !== undefined)) return false
  const normalised = remoteAddress.replace(/^::ffff:/, '')
  return normalised === '::1' || normalised.startsWith('127.')
}
