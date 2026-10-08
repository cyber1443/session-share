import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ChatMessage, MessageId } from '@session-share/protocol'
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

/**
 * The id of the last room message this checkout has been through, in the
 * server's order. An empty string means the room was empty when we caught up,
 * so everything in it is new. Older versions stored a local timestamp here;
 * a number is treated as no cursor at all, since comparing it to the server's
 * clock is the bug it was replaced for.
 */
type Cursors = Record<string, string | number>

/** The most messages one read returns; the inbox pages until it has them all. */
const PAGE = 200

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

function readCursor(key: string): string | undefined {
  const value = readCursors()[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * Written to a temporary file and renamed into place, so a hook and the MCP
 * server writing at once can lose an update but never leave half a file --
 * which would reset every cursor in it.
 */
function writeCursor(key: string, value: string): void {
  mkdirSync(stateDir(), { recursive: true })
  const path = inboxFile()
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporary, `${JSON.stringify({ ...readCursors(), [key]: value }, null, 2)}\n`)
  renameSync(temporary, path)
}

/**
 * Draws the line at whatever the room holds right now. Called on join, and on
 * the first pull for a checkout that has no cursor -- without it, attaching to
 * a long-running session would replay every directive ever sent into a fresh
 * agent at once. Never throws: a missing cursor is retried on the next pull.
 */
export async function markCaughtUp(config: SessionConfig, timeoutMs = 2500): Promise<void> {
  try {
    const { latestId } = await runCommand(
      config,
      { type: 'chat.read', limit: 1, beforeSeq: null, taskRef: null, afterId: null },
      timeoutMs,
    )
    writeCursor(cursorKey(config), latestId ?? '')
  } catch {
    // Retried on the next pull.
  }
}

export interface Inbox {
  messages: ChatMessage[]
  /** The cursor this read started from. */
  from: string
  /** Where the cursor goes once these have been handed over. */
  to: string
}

const addressedTo = (config: SessionConfig) => (message: ChatMessage) =>
  message.directive &&
  message.authorId !== config.participantId &&
  (message.mentions.length === 0 || message.mentions.includes(config.participantId as never))

/**
 * Directives addressed to this participant that they have not been handed yet,
 * without taking them. Your own messages never come back to you, and a
 * directive with mentions goes only to those mentioned.
 */
export async function readInbox(config: SessionConfig, timeoutMs = 2500): Promise<Inbox> {
  const key = cursorKey(config)
  const from = readCursor(key)
  if (from === undefined) {
    await markCaughtUp(config, timeoutMs)
    return { messages: [], from: readCursor(key) ?? '', to: readCursor(key) ?? '' }
  }

  const deadline = Date.now() + timeoutMs
  const messages: ChatMessage[] = []
  let cursor = from
  for (;;) {
    const remaining = Math.max(deadline - Date.now(), 250)
    const page = await runCommand(
      config,
      { type: 'chat.read', limit: PAGE, beforeSeq: null, taskRef: null, afterId: (cursor || null) as MessageId | null },
      remaining,
    )
    if (cursor && !page.cursorFound) {
      // The room this cursor belongs to is gone (a reset server). Start from now.
      return { messages: [], from, to: page.latestId ?? '' }
    }
    /**
     * Without a cursor the server returns the newest page, not the oldest, so
     * this is the whole read. Anything older than a full page since an empty
     * room is past saving and not worth replaying.
     */
    if (!cursor) {
      return { messages: page.messages.filter(addressedTo(config)), from, to: page.latestId ?? '' }
    }
    messages.push(...page.messages.filter(addressedTo(config)))
    if (page.messages.length > 0) cursor = page.messages.at(-1)!.id
    if (page.messages.length < PAGE) break
  }
  return { messages, from, to: cursor }
}

/**
 * Moves the cursor to `inbox.to`, but only if nobody else moved it since the
 * read. A headless run and the interactive session can both be holding the
 * same read; whichever hands it over second must not drag the cursor back.
 */
export function acknowledge(config: SessionConfig, inbox: Inbox): void {
  const key = cursorKey(config)
  if ((readCursor(key) ?? '') !== inbox.from) return
  if (inbox.to !== inbox.from) writeCursor(key, inbox.to)
}

/** Reads and takes, in one step: what the hooks and ss_inbox deliver. */
export async function pendingDirectives(
  config: SessionConfig,
  timeoutMs = 2500,
  consume = true,
): Promise<ChatMessage[]> {
  const inbox = await readInbox(config, timeoutMs)
  if (consume) acknowledge(config, inbox)
  return inbox.messages
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
