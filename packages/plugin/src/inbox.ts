import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ChatMessage } from '@session-share/protocol'
import { runCommand } from './client.js'
import type { SessionConfig } from './config.js'

/**
 * The room's outbound half: messages posted as directives are meant to land in
 * the recipient's Claude Code, not only on their screen. Claude Code has no way
 * to be pushed into, so delivery is a pull at the moments the hooks give us --
 * when a turn ends, when the human types, when a session starts.
 *
 * The cursor is per checkout and per participant, and lives outside the repo so
 * it never turns up in a diff.
 */
/**
 * Resolved per call rather than captured at import. A constant here binds to
 * whatever the environment was when this module happened to be loaded, which
 * is a surprising thing to depend on and impossible to exercise in a test.
 */
function stateDir(): string {
  return process.env.SESSION_SHARE_HOME ?? join(homedir(), '.session-share')
}

const inboxFile = () => join(stateDir(), 'inbox.json')

type Cursors = Record<string, number>

function cursorKey(config: SessionConfig): string {
  return `${config.serverUrl}|${config.sessionRef}|${config.participantId}`
}

function readCursors(): Cursors {
  const path = inboxFile()
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Cursors
  } catch {
    return {}
  }
}

function writeCursor(key: string, value: number): void {
  mkdirSync(stateDir(), { recursive: true })
  writeFileSync(inboxFile(), `${JSON.stringify({ ...readCursors(), [key]: value }, null, 2)}\n`)
}

/**
 * Draws the line at "now". Called on join, and on the first pull for a checkout
 * that predates this file -- without it, attaching to a long-running session
 * would replay every directive ever sent into a fresh agent at once.
 */
export function markCaughtUp(config: SessionConfig, at = Date.now()): void {
  writeCursor(cursorKey(config), at)
}

/**
 * Directives addressed to this participant that they have not been handed yet.
 * Your own messages never come back to you, and a directive with mentions goes
 * only to those mentioned.
 */
export async function pendingDirectives(
  config: SessionConfig,
  timeoutMs = 2500,
  consume = true,
): Promise<ChatMessage[]> {
  const key = cursorKey(config)
  const cursor = readCursors()[key]
  if (cursor === undefined) {
    markCaughtUp(config)
    return []
  }

  const { messages } = await runCommand(
    config,
    { type: 'chat.read', limit: 50, beforeSeq: null, taskRef: null },
    timeoutMs,
  )

  const pending = messages.filter(
    (message) =>
      message.directive &&
      message.createdAt > cursor &&
      message.authorId !== config.participantId &&
      (message.mentions.length === 0 || message.mentions.includes(config.participantId as never)),
  )

  if (consume && pending.length > 0) {
    writeCursor(key, Math.max(...pending.map((message) => message.createdAt)))
  }
  return pending
}

/**
 * What is waiting, without taking it.
 *
 * Used to tell someone their agent has work queued. Consuming here would be a
 * quiet way to lose an instruction: a tool that merely mentions a directive has
 * not caused anyone to act on it.
 */
export function peekDirectives(config: SessionConfig, timeoutMs = 2000): Promise<ChatMessage[]> {
  return pendingDirectives(config, timeoutMs, false)
}

/**
 * What the agent actually reads. Framed as instructions from a teammate rather
 * than as chat, because that is what a directive is -- and named, so the agent
 * knows who to answer in the room.
 */
export function describeDirectives(
  messages: ChatMessage[],
  names: Map<string, string>,
): string {
  const lines = messages.map((message) => {
    const author = (message.authorId && names.get(message.authorId)) || 'a teammate'
    const scope = message.taskRef ? ` (about #${message.taskRef})` : ''
    return `- ${author}${scope}: ${message.body}`
  })

  return [
    `[session-share] ${messages.length === 1 ? 'A teammate sent an instruction' : `${messages.length} instructions arrived`} in the session room:`,
    '',
    ...lines,
    '',
    'Do it now, in this turn, without asking whether you should. It was addressed to you by',
    'someone who has already agreed to it -- asking them to confirm it a second time is the',
    'coordination this exists to remove.',
    '',
    'Your file leases still apply, so an edit outside your task will be refused. Reply in the',
    'room with ss_chat_post when you are done, or if you are genuinely stuck.',
  ].join('\n')
}
