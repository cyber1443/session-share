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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // A JSON content-type with no body is rejected outright, so only set it when
  // there is something to send.
  const response = await fetch(path, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json', ...init.headers } : init?.headers,
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

export const api = {
  me: () =>
    request<{ user: Me | null; devLogin: boolean; githubConfigured: boolean }>('/api/me'),
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
