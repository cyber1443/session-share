import { relative, resolve } from 'node:path'
import type { SessionSnapshot } from '@session-share/protocol'
import { readConfig, type SessionConfig } from './config.js'
import { runCommand } from './client.js'
import { describeDirectives, pendingDirectives } from './inbox.js'
import { readPreferences } from './preferences.js'
import { usageSince } from './usage.js'

/**
 * Every hook the plugin installs, in one process.
 *
 * PreToolUse is the lease gate: it runs before every Edit/Write, so it has one
 * job and a hard latency budget. The rest deliver the session room into this
 * Claude Code -- Claude Code cannot be pushed into, so the room is pulled at
 * the three moments a hook gets to speak.
 *
 * All of it fails OPEN. A coordination server that is down or slow must never
 * stop a developer from editing their own repository -- the cost of a missed
 * check is a merge conflict, the cost of a false block is a wedged session.
 */
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const TIMEOUT_MS = 1500
const ROOM_TIMEOUT_MS = 2500

interface HookInput {
  hook_event_name?: string
  /** Written by Claude Code; every assistant message in it carries its usage. */
  transcript_path?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
  cwd?: string
  /** Set when a Stop hook already blocked this turn; blocking again would loop. */
  stop_hook_active?: boolean
}

interface DenyOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse'
    permissionDecision: 'allow' | 'deny' | 'ask'
    permissionDecisionReason: string
  }
}

interface ContextOutput {
  hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit' | 'SessionStart'
    additionalContext: string
  }
}

interface ContinueOutput {
  decision: 'block'
  reason: string
}

export function extractPaths(toolInput: Record<string, unknown> | undefined): string[] {
  if (!toolInput) return []
  const paths: string[] = []
  for (const key of ['file_path', 'notebook_path', 'path']) {
    const value = toolInput[key]
    if (typeof value === 'string' && value.length > 0) paths.push(value)
  }
  return paths
}

/** Repo-relative, because that is the shape every ownedPaths glob is written in. */
export function toRepoRelative(repoPath: string, cwd: string, filePath: string): string {
  const absolute = resolve(cwd, filePath)
  return relative(repoPath, absolute).split('\\').join('/')
}

export async function decide(input: HookInput): Promise<DenyOutput | null> {
  if (!input.tool_name || !EDIT_TOOLS.has(input.tool_name)) return null

  const cwd = input.cwd ?? process.cwd()
  const config = readConfig(cwd)
  if (!config) return null // not attached to a session; nothing to enforce

  const paths = extractPaths(input.tool_input)
    .map((p) => toRepoRelative(config.repoPath, cwd, p))
    .filter((p) => p.length > 0 && !p.startsWith('..'))
  if (paths.length === 0) return null

  let result
  try {
    result = await runCommand(config, { type: 'lease.check', paths }, TIMEOUT_MS)
  } catch (error) {
    process.stderr.write(
      `[session-share] lease check skipped: ${error instanceof Error ? error.message : error}\n`,
    )
    return null // fail open
  }

  if (result.allowed) return null

  const reason = result.denials.map((denial) => denial.message).join('\n')
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }
}

/** Names for the authors, so a delivered directive reads as coming from a person. */
async function participantNames(config: SessionConfig): Promise<Map<string, string>> {
  try {
    const response = await fetch(new URL(`/sessions/${config.sessionRef}/snapshot`, config.serverUrl), {
      headers: config.participantToken ? { authorization: `Bearer ${config.participantToken}` } : {},
      signal: AbortSignal.timeout(ROOM_TIMEOUT_MS),
    })
    if (!response.ok) return new Map()
    const snapshot = (await response.json()) as SessionSnapshot
    return new Map(snapshot.participants.map((p) => [p.id as string, p.displayName]))
  } catch {
    return new Map()
  }
}

/** Anything the room has for this participant, already formatted for the agent. */
export async function collectRoom(input: HookInput): Promise<string | null> {
  const config = readConfig(input.cwd ?? process.cwd())
  if (!config) return null
  if (!readPreferences().acceptDirectives) return null

  let pending
  try {
    pending = await pendingDirectives(config, ROOM_TIMEOUT_MS)
  } catch {
    return null // fail open, same as the lease gate
  }
  if (pending.length === 0) return null

  return describeDirectives(pending, await participantNames(config))
}

/** Sends the turn's token count, attributed by the server to whatever is held. */
async function reportUsage(input: HookInput): Promise<void> {
  const config = readConfig(input.cwd ?? process.cwd())
  if (!config) return

  const delta = usageSince(input.transcript_path)
  if (delta.inputTokens + delta.outputTokens === 0) return

  try {
    await runCommand(config, { type: 'usage.report', ...delta }, ROOM_TIMEOUT_MS)
  } catch {
    // Accounting is never a reason to interfere with someone's session.
  }
}

export async function route(
  input: HookInput,
): Promise<DenyOutput | ContextOutput | ContinueOutput | null> {
  const event = input.hook_event_name ?? (input.tool_name ? 'PreToolUse' : '')

  switch (event) {
    case 'PreToolUse':
      return decide(input)

    /**
     * The turn is over and the agent is about to go idle -- the one moment it
     * can be handed work without a human typing. Blocking here makes Claude
     * continue with the directive as its instruction.
     */
    case 'Stop': {
      // Whose account paid for the turn that just ended, and for what.
      await reportUsage(input)
      if (input.stop_hook_active) return null // we already spoke this turn
      const reason = await collectRoom(input)
      return reason ? { decision: 'block', reason } : null
    }

    // The human is already talking to the agent; ride along rather than interrupt.
    case 'UserPromptSubmit':
    case 'SessionStart': {
      const additionalContext = await collectRoom(input)
      return additionalContext
        ? { hookSpecificOutput: { hookEventName: event, additionalContext } }
        : null
    }

    default:
      return null
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

const isEntrypoint = process.argv[1]?.endsWith('hook.js') ?? false

if (isEntrypoint) {
  const raw = await readStdin()
  let input: HookInput = {}
  try {
    input = JSON.parse(raw) as HookInput
  } catch {
    process.exit(0) // unparseable input is not a reason to block an edit
  }

  const output = await route(input)
  if (output) process.stdout.write(JSON.stringify(output))
  process.exit(0)
}
