import type { ClientCommand, CommandResultMap } from '@session-share/protocol'

export class CommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'CommandError'
  }
}

/**
 * One-shot HTTP client. Deliberately not a WebSocket: the hook is a new process
 * on every edit and the MCP tools are request/response, so a persistent socket
 * would buy nothing but reconnect bugs. The board holds the live socket.
 */
export interface CommandTarget {
  serverUrl: string
  sessionRef: string
  /** Null only for session.join, which is how a caller gets one. */
  participantId: string | null
  /** Bearer credential from redeeming a join code; identifies session + participant. */
  participantToken?: string | null
}

export interface PairResult {
  participantId: string
  participantToken: string
  sessionRef: string
  sessionTitle: string
  displayName: string
  githubLogin: string
}

/**
 * Redeems a one-time join code for this checkout. The code is single-use and
 * expires in 15 minutes, so the copy left behind in shell history is inert.
 */
export async function pair(
  serverUrl: string,
  token: string,
  repoPath: string,
): Promise<PairResult> {
  const response = await fetch(new URL('/api/join', serverUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, repoPath }),
  })
  const payload = (await response.json()) as PairResult & { error?: string; message?: string }
  if (!response.ok) throw new CommandError(payload.error ?? 'internal', payload.message ?? 'join failed')
  return payload
}

export async function runCommand<T extends ClientCommand['type']>(
  config: CommandTarget,
  command: Extract<ClientCommand, { type: T }>,
  timeoutMs = 3000,
): Promise<CommandResultMap[T]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(new URL('/api/commands', config.serverUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.participantToken
          ? { authorization: `Bearer ${config.participantToken}` }
          : {}),
      },
      body: JSON.stringify({ sessionRef: config.sessionRef, command }),
      signal: controller.signal,
    })

    const payload = (await response.json()) as
      | { data: CommandResultMap[T] }
      | { error: string; message?: string }

    if (!response.ok || 'error' in payload) {
      const failure = payload as { error: string; message?: string }
      throw new CommandError(failure.error, failure.message ?? failure.error)
    }
    return payload.data
  } finally {
    clearTimeout(timer)
  }
}
