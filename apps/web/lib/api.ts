import type {
  ClientCommand,
  CommandResultMap,
  RepoRef,
  SessionPhase,
  SessionSnapshot,
} from '@session-share/protocol'

export interface Me {
  id: string
  githubLogin: string
  displayName: string
  avatarUrl: string | null
  /**
   * The seat this browser's token holds, in peer mode. One person can hold a
   * seat per checkout, so matching on the user id alone can pick the wrong one.
   */
  participantId?: string | null
}

export interface SessionSummary {
  id: string
  slug: string
  title: string
  phase: SessionPhase
  repo: RepoRef
  issueRef: string | null
  createdAt: number
  participants: Array<{
    id: string
    displayName: string
    avatarUrl: string | null
    connected: boolean
    colorIndex: number
  }>
  mine: boolean
  taskCounts: Record<string, number>
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/** The token used last, whichever session it was for. */
const TOKEN_KEY = 'session-share.participantToken'
/** Every token this browser holds, by session. */
const TOKENS_KEY = 'session-share.participantTokens'

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

function readTokens(): Record<string, string> {
  try {
    return JSON.parse(storage()?.getItem(TOKENS_KEY) ?? '{}') as Record<string, string>
  } catch {
    return {}
  }
}

/** Which session's token requests carry; set once the board knows its session. */
let currentSession: string | null = null

/**
 * In peer mode there is no cookie: the board holds the participant token it got
 * by redeeming an invite, and presents that instead. Kept in localStorage so a
 * reload does not send someone back to the invite link.
 *
 * Kept per session. One origin is one host's server, and a host runs several
 * sessions on it -- with a single slot, opening the second session's board
 * overwrote the first's token, and the first tab started acting as the second
 * session's seat.
 */
export const peerToken = {
  get: (sessionRef: string | null = currentSession): string | null => {
    const store = storage()
    if (!store) return null
    if (sessionRef) {
      const scoped = readTokens()[sessionRef]
      if (scoped) return scoped
    }
    return store.getItem(TOKEN_KEY)
  },
  set: (token: string, sessionRef?: string | null) => {
    const store = storage()
    if (!store) return
    store.setItem(TOKEN_KEY, token)
    if (sessionRef) store.setItem(TOKENS_KEY, JSON.stringify({ ...readTokens(), [sessionRef]: token }))
  },
  /** Point requests at one session's token. */
  use: (sessionRef: string | null) => {
    currentSession = sessionRef
  },
  clear: () => {
    const store = storage()
    if (!store) return
    const last = store.getItem(TOKEN_KEY)
    store.removeItem(TOKEN_KEY)
    // Drop the one that failed from the per-session map too, so it is not tried again.
    const remaining = Object.fromEntries(Object.entries(readTokens()).filter(([, t]) => t !== last))
    store.setItem(TOKENS_KEY, JSON.stringify(remaining))
  },
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = peerToken.get()
  // A JSON content-type with no body is rejected outright, so only set it when
  // there is something to send.
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  })
  const payload = response.status === 204 ? null : await response.json().catch(() => null)
  if (!response.ok) {
    const failure = payload as { error?: string; message?: string } | null
    throw new ApiError(
      response.status,
      failure?.error ?? 'internal',
      failure?.message ?? response.statusText,
    )
  }
  return payload as T
}

export interface PeerJoinResult {
  participantId: string
  participantToken: string
  sessionRef: string
  sessionTitle: string
  displayName: string
  githubLogin: string
}

export const api = {
  me: () =>
    request<{
      mode: 'oauth' | 'peer'
      user: Me | null
      devLogin: boolean
      githubConfigured: boolean
    }>('/api/me'),
  /** Redeem an invite for a browser seat -- no checkout, so no lease. */
  peerJoin: (invite: string, identity: { githubLogin: string; displayName: string }) =>
    request<PeerJoinResult>('/api/peer/join', {
      method: 'POST',
      body: JSON.stringify({ invite, repoPath: null, ...identity }),
    }),
  devLogin: (login: string) =>
    request<{ user: Me }>('/auth/dev', { method: 'POST', body: JSON.stringify({ login }) }),
  logout: () => request<{ ok: true }>('/auth/logout', { method: 'POST' }),
  sessions: () => request<{ sessions: SessionSummary[] }>('/api/sessions'),
  createSession: (input: { slug: string; title: string; repo: RepoRef; issueRef: string | null }) =>
    request<{ sessionId: string; slug: string }>('/api/sessions', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  snapshot: (ref: string) => request<SessionSnapshot>(`/sessions/${ref}/snapshot`),
  joinToken: (ref: string) =>
    request<{ token: string; expiresAt: number; command: string }>(
      `/api/sessions/${ref}/join-token`,
      { method: 'POST' },
    ),
  invite: (ref: string) =>
    request<{ invite: string; sessionRef: string; sessionTitle: string }>(
      `/api/sessions/${ref}/invite`,
      { method: 'POST' },
    ),
  wsTicket: () => request<{ ticket: string }>('/api/ws-ticket'),
  command: <T extends ClientCommand['type']>(
    sessionRef: string,
    command: Extract<ClientCommand, { type: T }>,
  ) =>
    request<{ data: CommandResultMap[T] }>('/api/commands', {
      method: 'POST',
      body: JSON.stringify({ sessionRef, command }),
    }).then((r) => r.data),
}
