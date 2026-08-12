import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ChatMessage } from '@session-share/protocol'
import { runCommand } from './client.js'
import { readConfig, type SessionConfig } from './config.js'
import { describeDirectives, markCaughtUp, peekDirectives } from './inbox.js'
import { readPreferences, type Preferences } from './preferences.js'

/**
 * Queued work running itself while nobody is at the keyboard.
 *
 * Everything a session asks of a person already arrives as a directive -- split
 * this, start that, claim your tasks, run the assembled thing, open the PR --
 * and all of it reaches an agent only when a turn ends. An idle terminal has no
 * turn ending, so a session where one person stepped away stops dead.
 *
 * This closes that: it lives in the MCP server, which Claude Code keeps alive
 * for the whole session including while the agent is idle, and it runs the
 * waiting instruction in a *separate* headless Claude on the same account, in
 * the same checkout. The interactive session is untouched.
 *
 * It is deliberately not clever. It does not decide what to do; it hands over
 * exactly what a person would have been handed, and every guard that applies to
 * a person -- the file leases, the validator, the verify step -- applies here
 * unchanged, because it is the same plugin in the same repository.
 */
const POLL_MS = Number(process.env.SESSION_SHARE_AUTOPILOT_POLL_MS ?? 20_000)

/** Long enough that a turn already in flight wins the race and this never starts. */
const IDLE_GRACE_MS = Number(process.env.SESSION_SHARE_AUTOPILOT_GRACE_MS ?? 25_000)

function stateDir(): string {
  return process.env.SESSION_SHARE_HOME ?? join(homedir(), '.session-share')
}

const spendFile = () => join(stateDir(), 'autopilot.json')

interface Spend {
  day: string
  tokens: number
}

export function readSpend(today: string): Spend {
  try {
    const spend = JSON.parse(readFileSync(spendFile(), 'utf8')) as Spend
    return spend.day === today ? spend : { day: today, tokens: 0 }
  } catch {
    return { day: today, tokens: 0 }
  }
}

export function addSpend(today: string, tokens: number): void {
  const spend = readSpend(today)
  mkdirSync(stateDir(), { recursive: true })
  writeFileSync(spendFile(), `${JSON.stringify({ day: today, tokens: spend.tokens + tokens })}\n`)
}

export type Decision =
  | { run: true; reason: 'work is waiting' }
  | { run: false; reason: string }

/**
 * Whether to start a headless run. Pure, because every reason not to is a rule
 * someone will want to check, and none of them should need a subprocess to test.
 */
export function decide(input: {
  preferences: Pick<Preferences, 'autopilot' | 'autopilotBudget'>
  pending: number
  /** Directives that only planning may act on, when the mode is `splits`. */
  planningOnly: boolean
  inFlight: boolean
  spentToday: number
}): Decision {
  if (input.preferences.autopilot === 'off') return { run: false, reason: 'autopilot is off' }
  if (input.pending === 0) return { run: false, reason: 'nothing is waiting' }
  if (input.inFlight) return { run: false, reason: 'a headless run is already going' }
  if (input.preferences.autopilot === 'splits' && !input.planningOnly) {
    return { run: false, reason: 'autopilot is set to splits only, and this is not a split' }
  }
  if (input.spentToday >= input.preferences.autopilotBudget) {
    return { run: false, reason: `today's unattended budget is spent (${input.spentToday})` }
  }
  return { run: true, reason: 'work is waiting' }
}

/** A split reads and proposes; it never edits, so it can be locked to that. */
const PLANNING_TOOLS = [
  'Read',
  'Grep',
  'Glob',
  'mcp__session-share__ss_propose',
  'mcp__session-share__ss_tickets',
  'mcp__session-share__ss_get_contract',
  'mcp__session-share__ss_chat_post',
]

const isPlanning = (messages: ChatMessage[]) =>
  messages.every((message) => /ss_propose|Split the ticket/.test(message.body))

let running = false
/** After a failed run, stop hammering: the next one will fail the same way. */
let failedUntil = 0
const FAILURE_BACKOFF_MS = 5 * 60 * 1000

const logFile = () => join(stateDir(), 'autopilot.log')

function log(line: string): void {
  try {
    mkdirSync(stateDir(), { recursive: true })
    appendFileSync(logFile(), `${new Date().toISOString()} ${line}\n`)
  } catch {
    // Logging is never worth failing over.
  }
}

export interface RunResult {
  ok: boolean
  code: number | null
  detail: string
}

/** Runs one instruction in a headless Claude on this machine, in this repo. */
function runHeadless(
  config: SessionConfig,
  prompt: string,
  planningOnly: boolean,
  command = 'claude',
): Promise<RunResult> {
  return new Promise((resolve) => {
    const args = ['-p', prompt, '--add-dir', config.repoPath]
    if (planningOnly) args.push('--allowedTools', ...PLANNING_TOOLS)

    const child = spawn(command, args, {
      cwd: config.repoPath,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Its own hooks must not recurse into another headless run.
        SESSION_SHARE_AUTOPILOT: 'child',
      },
    })

    let tail = ''
    const keep = (chunk: Buffer) => {
      tail = `${tail}${chunk}`.slice(-2000)
    }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)

    child.on('error', (error) => {
      log(`spawn failed: ${error.message}`)
      resolve({ ok: false, code: null, detail: error.message })
    })
    child.on('close', (code) => {
      log(`exit ${code}\n${tail}`)
      resolve({
        ok: code === 0,
        code,
        detail: tail.trim().split('\n').slice(-3).join(' ').slice(0, 300),
      })
    })
  })
}

export interface TickOptions {
  /** The binary to run. Injectable so a test can watch a spawn fail. */
  command?: string
  graceMs?: number
}

export interface TickResult {
  ran: boolean
  ok: boolean
  reason: string
}

export async function tickOnce(options: TickOptions = {}): Promise<TickResult> {
  const config = readConfig(process.env.SESSION_SHARE_REPO ?? process.cwd())
  if (!config) return { ran: false, ok: false, reason: 'this checkout is not in a session' }

  const preferences = readPreferences()
  const today = new Date().toISOString().slice(0, 10)

  let waiting: ChatMessage[]
  try {
    waiting = await peekDirectives(config)
  } catch {
    return { ran: false, ok: false, reason: 'the server did not answer' }
  }

  const planningOnly = waiting.length > 0 && isPlanning(waiting)
  const verdict = decide({
    preferences,
    pending: waiting.length,
    planningOnly,
    inFlight: running || Date.now() < failedUntil,
    spentToday: readSpend(today).tokens,
  })
  if (!verdict.run) return { ran: false, ok: false, reason: verdict.reason }

  /**
   * Anything waiting this long has already been offered to the interactive
   * session and not taken. Without the grace period a headless run would race
   * the person who is right there typing.
   */
  const oldest = Math.min(...waiting.map((message) => message.createdAt))
  if (Date.now() - oldest < (options.graceMs ?? IDLE_GRACE_MS)) {
    return { ran: false, ok: false, reason: 'the interactive session may still take it' }
  }

  running = true
  try {
    /**
     * Run first, take second.
     *
     * Taking the work up front loses it whenever the run fails: the cursor
     * moves, the instruction is gone, and the card sits there claiming an agent
     * is on it. The interactive session doing the same work twice is a far
     * cheaper failure than work disappearing, so the cursor only moves once
     * something has actually run.
     */
    const result = await runHeadless(
      config,
      describeDirectives(waiting, new Map()),
      planningOnly,
      options.command ?? 'claude',
    )

    if (!result.ok) {
      failedUntil = Date.now() + FAILURE_BACKOFF_MS
      await say(
        config,
        `Tried to run that headlessly and could not (${result.detail || `exit ${result.code}`}). It is still waiting for someone -- see ${logFile()}.`,
      )
      return { ran: true, ok: false, reason: result.detail || `exit ${result.code}` }
    }

    // Only now is it safe to say this has been handed over.
    markCaughtUp(config, Math.max(...waiting.map((message) => message.createdAt)))

    /**
     * The headless run reports its own tokens through the same hook as any
     * other turn; this only tracks the ceiling, so a rough charge is enough.
     */
    addSpend(today, 20_000)
    await say(config, `Ran that headlessly -- nobody was at the keyboard. ${waiting.length} instruction(s).`)
    return { ran: true, ok: true, reason: 'done' }
  } catch (error) {
    log(`tick failed: ${error instanceof Error ? error.message : error}`)
    return { ran: true, ok: false, reason: String(error) }
  } finally {
    running = false
  }
}

const say = (config: SessionConfig, body: string) =>
  runCommand(config, { type: 'chat.post', body, taskRef: null, asAgent: true, directive: false }).catch(
    () => undefined,
  )

/** Starts polling. Returns a stop function, and does nothing in a child run. */
export function startAutopilot(): () => void {
  if (process.env.SESSION_SHARE_AUTOPILOT === 'child') return () => undefined

  const timer = setInterval(() => void tickOnce(), POLL_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}
