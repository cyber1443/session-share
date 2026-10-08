import type { ClientCommand, CommandResultMap } from '@session-share/protocol'
import { machineId } from './daemon.js'

/**
 * A refusal from the server, with enough of the answer kept to act on. The
 * message is for people; `status` and `reason` are for code, which used to
 * have nothing but the message to pattern-match on.
 */
export class CommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** The HTTP status, when the refusal came over HTTP. */
    readonly status: number | null = null,
    /** Why a token was refused -- `token_invalid`, `session_gone`, `seat_gone`, `other_session`. */
    readonly reason: string | null = null,
  ) {
    super(message)
    this.name = 'CommandError'
  }
}

type Refusal = { error?: string; message?: string; reason?: string }

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
 * Peer-mode join: the invite is the credential and the name comes from this
 * machine. No login, no registered application, no one-time code to mint.
 */
export async function peerJoin(
  serverUrl: string,
  invite: string,
  identity: { githubLogin: string; displayName: string },
  repoPath: string | null,
): Promise<PairResult> {
  const response = await fetch(new URL('/api/peer/join', serverUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // The machine makes the checkout: same path, different laptop, different seat.
    body: JSON.stringify({ invite, repoPath, machineId: repoPath ? machineId() : null, ...identity }),
  })
  const payload = (await response.json()) as PairResult & Refusal
  if (!response.ok) {
    throw new CommandError(
      payload.error ?? 'internal',
      payload.message ?? 'join failed',
      response.status,
      payload.reason ?? null,
    )
  }
  return payload
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
    body: JSON.stringify({ token, repoPath, machineId: machineId() }),
  })
  const payload = (await response.json()) as PairResult & Refusal
  if (!response.ok) {
    throw new CommandError(
      payload.error ?? 'internal',
      payload.message ?? 'join failed',
      response.status,
      payload.reason ?? null,
    )
  }
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

    const payload = (await response.json()) as { data: CommandResultMap[T] } | (Refusal & { error: string })

    if (!response.ok || 'error' in payload) {
      const failure = payload as Refusal & { error: string }
      throw new CommandError(
        failure.error,
        failure.message ?? failure.error,
        response.status,
        failure.reason ?? null,
      )
    }
    return payload.data
  } finally {
    clearTimeout(timer)
  }
}
