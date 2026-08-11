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

export interface AuthConfig {
  /** Signs cookies, participant tokens and ws tickets. */
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

export function decodeToken<T>(secret: string, token: string): T | null {
  const [body, signature] = token.split('.')
  if (!body || !signature || !safeEqual(signature, sign(secret, body))) return null
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T & {
      exp?: number
    }
    if (typeof claims.exp === 'number' && claims.exp < Date.now()) return null
    return claims
  } catch {
    return null
  }
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
}

export interface WsTicketClaims {
  kind: 'ws'
  userId: string
  exp: number
}

export function issueParticipantToken(config: AuthConfig, claims: Omit<ParticipantClaims, 'kind'>): string {
  return encodeToken(config.secret, { ...claims, kind: 'participant' })
}

export function readParticipantToken(config: AuthConfig, token: string): ParticipantClaims | null {
  const claims = decodeToken<ParticipantClaims>(config.secret, token)
  return claims?.kind === 'participant' ? claims : null
}

export function issueWsTicket(config: AuthConfig, userId: string): string {
  return encodeToken(config.secret, { kind: 'ws', userId, exp: Date.now() + WS_TICKET_TTL_MS })
}

export function readWsTicket(config: AuthConfig, ticket: string): WsTicketClaims | null {
  const claims = decodeToken<WsTicketClaims>(config.secret, ticket)
  return claims?.kind === 'ws' ? claims : null
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

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  return {
    secret: env.SESSION_SHARE_SECRET ?? randomBytes(32).toString('hex'),
    githubClientId: env.GITHUB_CLIENT_ID ?? null,
    githubClientSecret: env.GITHUB_CLIENT_SECRET ?? null,
    callbackUrl: env.GITHUB_CALLBACK_URL ?? 'http://127.0.0.1:3000/auth/github/callback',
    devLogin: env.SESSION_SHARE_DEV_LOGIN === '1',
  }
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])

/** Dev login is a backdoor; it must never be reachable off the machine. */
export function devLoginAllowed(config: AuthConfig, host: string | undefined): boolean {
  if (!config.devLogin) return false
  const hostname = (host ?? '').split(':')[0] ?? ''
  return LOOPBACK.has(hostname)
}
