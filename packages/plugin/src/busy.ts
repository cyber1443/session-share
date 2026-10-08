import { createHash } from 'node:crypto'
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Whether the interactive Claude Code in a checkout is in the middle of a turn.
 *
 * Set when the human submits a prompt, cleared when the turn ends. The headless
 * autopilot reads it so it never starts a second agent in a working tree whose
 * first agent is still editing. A marker older than MAX_TURN_MS is ignored: a
 * session that crashed mid-turn never gets its Stop hook, and must not keep the
 * checkout busy forever.
 */
const MAX_TURN_MS = 2 * 60 * 60 * 1000

function marker(repoPath: string): string {
  const home = process.env.SESSION_SHARE_HOME ?? join(homedir(), '.session-share')
  const id = createHash('sha256').update(repoPath).digest('hex').slice(0, 16)
  return join(home, 'busy', id)
}

export function markBusy(repoPath: string): void {
  try {
    const path = marker(repoPath)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, `${process.pid}\n`)
  } catch {
    // Best effort; the worst case is an autopilot run that waits for the grace period.
  }
}

export function markIdle(repoPath: string): void {
  rmSync(marker(repoPath), { force: true })
}

export function isBusy(repoPath: string): boolean {
  try {
    return Date.now() - statSync(marker(repoPath)).mtimeMs < MAX_TURN_MS
  } catch {
    return false
  }
}
