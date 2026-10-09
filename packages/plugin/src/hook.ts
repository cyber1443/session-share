import { realpathSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import type { SessionSnapshot } from '@session-share/protocol'
import { readConfig, type SessionConfig } from './config.js'
import { runCommand } from './client.js'
import { markBusy, markIdle } from './busy.js'
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
  /** What was typed, on UserPromptSubmit. */
  prompt?: string
}

/**
 * What a shell command or a prompt looks like once anything that resembles a
 * credential is masked. The board is shared; `export GITHUB_TOKEN=...` should
 * not be.
 */
export function redact(text: string): string {
  return text
    .replace(/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***')
    .replace(/\b([A-Za-z_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASS|PWD|AUTH)[A-Za-z_]*\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1***')
    .replace(/\b(ghp|gho|ghu|ghs|github_pat|sk|sk-ant|xox[abp]|ssx|ssj)_?[A-Za-z0-9_-]{12,}/g, '***')
    .replace(/(--(?:password|token|secret|api-key)[= ])\S+/gi, '$1***')
    .replace(/:\/\/[^/\s:@]+:[^/\s@]+@/g, '://***@')
}

/** Short: this runs before every shell command, so it may cost a blink, never a wait. */
const DOING_TIMEOUT_MS = 400

/**
 * Tells the board what this Claude just started on. Best effort and quick:
 * a board missing one line is nothing, a shell command waiting on a slow
 * network is something.
 */
async function reportDoing(input: HookInput, text: string): Promise<void> {
  const config = readConfig(input.cwd ?? process.cwd())
  if (!config) return
  const line = redact(text).replace(/\s+/g, ' ').trim().slice(0, 200)
  if (!line) return
  try {
    await runCommand(config, { type: 'agent.doing', text: line }, DOING_TIMEOUT_MS)
  } catch {
    // The board can do without it.
  }
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

/**
 * The path as the filesystem itself spells it: symlinks resolved, and on a
 * case-insensitive volume, the case on disk. Without this `/tmp/repo/src` and
 * `/private/tmp/repo/src`, or `SRC/a.ts` and `src/a.ts`, are different strings
 * for the same file, and only one of them would be checked. A file that does
 * not exist yet is resolved through its deepest existing ancestor.
 */
export function canonical(path: string): string {
  const tail: string[] = []
  let current = resolve(path)
  for (;;) {
    try {
      return join(realpathSync.native(current), ...tail.reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) return resolve(path)
      tail.push(basename(current))
      current = parent
    }
  }
}

/** Repo-relative, because that is the shape every ownedPaths glob is written in. */
export function toRepoRelative(repoPath: string, cwd: string, filePath: string): string {
  const absolute = canonical(resolve(cwd, filePath))
  return relative(canonical(repoPath), absolute).split('\\').join('/')
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
  /**
   * A headless autopilot run was started *for* the directives it was handed.
   * Its own hooks taking more would either consume them before it reports back
   * or run them twice; the autopilot moves the cursor itself when it is done.
   */
  if (process.env.SESSION_SHARE_AUTOPILOT === 'child') return null

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
      // Edits are reported by the lease check itself; a shell command says what it runs.
      if (input.tool_name === 'Bash') {
        const command = typeof input.tool_input?.command === 'string' ? input.tool_input.command : ''
        const said = typeof input.tool_input?.description === 'string' ? input.tool_input.description : ''
        await reportDoing(input, `running ${said ? `${said}: ` : ''}${command}`)
        return null
      }
      return decide(input)

    /**
     * The turn is over and the agent is about to go idle -- the one moment it
     * can be handed work without a human typing. Blocking here makes Claude
     * continue with the directive as its instruction.
     */
    case 'Stop': {
      // Whose account paid for the turn that just ended, and for what.
      await reportUsage(input)
      const config = readConfig(input.cwd ?? process.cwd())
      const reason = input.stop_hook_active ? null : await collectRoom(input) // we already spoke this turn
      // Handing over a directive keeps the turn going; otherwise the agent is idle now.
      if (config && !reason && process.env.SESSION_SHARE_AUTOPILOT !== 'child') markIdle(config.repoPath)
      await reportDoing(input, reason ? 'picking up an instruction from the room' : 'idle -- waiting for the next prompt')
      return reason ? { decision: 'block', reason } : null
    }

    // The human is already talking to the agent; ride along rather than interrupt.
    case 'UserPromptSubmit':
    case 'SessionStart': {
      if (event === 'UserPromptSubmit' && process.env.SESSION_SHARE_AUTOPILOT !== 'child') {
        const config = readConfig(input.cwd ?? process.cwd())
        if (config) markBusy(config.repoPath)
      }
      if (event === 'UserPromptSubmit') {
        const first = (input.prompt ?? '').split('\n').find((line) => line.trim()) ?? ''
        await reportDoing(
          input,
          process.env.SESSION_SHARE_AUTOPILOT === 'child' ? `autopilot: ${first}` : `on: ${first}`,
        )
      }
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
