import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { STATE_DIR } from './daemon.js'

/**
 * Choices about what happens in someone's repository, made once by them rather
 * than decided here. Where a default could commit, push or publish on their
 * behalf, it errs toward the version that does less.
 */
export const Preferences = z.object({
  /**
   * explicit: nothing is committed until you run /ss:done.
   * auto-on-green: the agent commits when it reports a passing acceptance test.
   */
  commitPolicy: z.enum(['explicit', 'auto-on-green']).default('explicit'),
  /** Push branches to origin. Off means two clones never exchange code. */
  push: z.boolean().default(true),
  /** Open a pull request per task, and one for the finished session. */
  openPullRequests: z.boolean().default(true),
  /** Whether hosting binds the local network or only this machine. */
  expose: z.enum(['lan', 'loopback']).default('lan'),
  /** Open the live board automatically when you host or join. */
  openBoard: z.boolean().default(true),
  /**
   * Let messages sent to the room as directives run in this Claude Code
   * session. Off makes the room read-only: you still see everything, but
   * nothing anyone types reaches your agent.
   */
  acceptDirectives: z.boolean().default(true),
  /**
   * Whether queued work runs itself when this Claude Code is idle.
   *
   * `full` is the point of the product: the only thing anyone should have to do
   * is join a ticket. It also means an agent writes to this repository and
   * pushes branches with nobody watching, which is why it is one word to turn
   * off and why the spend is capped.
   */
  autopilot: z.enum(['off', 'splits', 'full']).default('full'),
  /** Tokens per day this machine may spend unattended. */
  autopilotBudget: z.number().int().min(0).default(1_000_000),
  /** Set once the setup questions have been answered. */
  configured: z.boolean().default(false),
})
export type Preferences = z.infer<typeof Preferences>

const PREFERENCES_PATH = join(STATE_DIR, 'preferences.json')

export function readPreferences(): Preferences {
  if (!existsSync(PREFERENCES_PATH)) return Preferences.parse({})
  try {
    return Preferences.parse(JSON.parse(readFileSync(PREFERENCES_PATH, 'utf8')))
  } catch {
    return Preferences.parse({})
  }
}

export function writePreferences(update: Partial<Preferences>): Preferences {
  const merged = Preferences.parse({ ...readPreferences(), ...update })
  mkdirSync(dirname(PREFERENCES_PATH), { recursive: true })
  writeFileSync(PREFERENCES_PATH, `${JSON.stringify(merged, null, 2)}\n`)
  return merged
}

export const PREFERENCES_FILE = PREFERENCES_PATH

/** Human-readable summary, so a tool can show what it is about to do. */
export function describePreferences(preferences: Preferences): string {
  return [
    `commits:  ${preferences.commitPolicy === 'explicit' ? 'only when you run /ss:done' : 'automatically when the acceptance test passes'}`,
    `push:     ${preferences.push ? 'branches are pushed to origin' : 'nothing leaves this machine'}`,
    `PRs:      ${preferences.openPullRequests ? 'opened per task and for the session' : 'never opened'}`,
    `hosting:  ${preferences.expose === 'lan' ? 'reachable on your local network' : 'this machine only'}`,
    `board:    ${preferences.openBoard ? 'opens in your browser on host and join' : 'never opened for you'}`,
    `room:     ${preferences.acceptDirectives ? 'directives from the room run in this session' : 'read-only; nothing from the room reaches your agent'}`,
    `autopilot: ${
      preferences.autopilot === 'off'
        ? 'off — queued work waits for you'
        : preferences.autopilot === 'splits'
          ? `planning runs itself when you are idle (up to ${preferences.autopilotBudget.toLocaleString()} tokens/day)`
          : `everything runs itself when you are idle, including writing and pushing code (up to ${preferences.autopilotBudget.toLocaleString()} tokens/day)`
    }`,
  ].join('\n')
}
