import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readConfig } from './config.js'
import { readPreferences } from './preferences.js'

/**
 * Starting and finding a checkout's terminal host: the process that runs
 * board terminals on this machine. Detached from the Claude Code that started
 * it, the way the coordination server is, so a terminal someone is driving
 * from the board does not die because a window was closed here.
 */

function stateDir(): string {
  return process.env.SESSION_SHARE_HOME ?? join(homedir(), '.session-share')
}

const lockFile = (repoPath: string) =>
  join(stateDir(), 'terminal', `${createHash('sha256').update(resolve(repoPath)).digest('hex').slice(0, 16)}.json`)

export const terminalLogFile = () => join(stateDir(), 'terminal.log')

interface Lock {
  pid: number
  build: string
}

/** The host's own file: bundle/terminal.js when installed, dist/terminal-host.js in the monorepo. */
export function terminalHostEntry(): string | null {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    process.env.SESSION_SHARE_TERMINAL_ENTRY,
    resolve(here, 'terminal.js'),
    resolve(here, 'terminal-host.js'),
  ].filter((value): value is string => Boolean(value))
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

/** Which code a host is running, so an update replaces a host left over from before it. */
export function buildOf(entry: string): string {
  const stat = statSync(entry)
  return `${stat.size}-${Math.round(stat.mtimeMs)}`
}

export function readLock(repoPath: string): Lock | null {
  try {
    return JSON.parse(readFileSync(lockFile(repoPath), 'utf8')) as Lock
  } catch {
    return null
  }
}

export function writeLock(repoPath: string, lock: Lock): void {
  const path = lockFile(repoPath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(lock)}\n`)
}

export function clearLock(repoPath: string, pid: number): void {
  if (readLock(repoPath)?.pid === pid) rmSync(lockFile(repoPath), { force: true })
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export type HostStart = 'started' | 'running' | 'off' | 'not in a session' | 'missing'

/**
 * Makes sure this checkout's terminal host is running, if terminals are on.
 * Cheap enough to call on every start of the MCP server: a host already
 * running the same code is left alone.
 */
export function ensureTerminalHost(repoPath: string): HostStart {
  if (readPreferences().terminal === 'off') return 'off'
  const config = readConfig(repoPath)
  if (!config?.participantToken) return 'not in a session'
  const entry = terminalHostEntry()
  if (!entry) return 'missing'

  const lock = readLock(config.repoPath)
  if (lock && isAlive(lock.pid)) {
    if (lock.build === buildOf(entry)) return 'running'
    // Left over from an older plugin: it goes, and this one takes its place.
    try {
      process.kill(lock.pid, 'SIGTERM')
    } catch {
      // Already gone.
    }
  }

  mkdirSync(stateDir(), { recursive: true })
  const out = openSync(terminalLogFile(), 'a')
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: ['ignore', out, out],
    cwd: config.repoPath,
    env: { ...process.env, SESSION_SHARE_REPO: config.repoPath, SESSION_SHARE_AUTOPILOT: 'off' },
  })
  child.unref()
  return 'started'
}

/** Stops this checkout's terminal host, and with it any terminal it is running. */
export function stopTerminalHost(repoPath: string): boolean {
  const config = readConfig(repoPath)
  const lock = readLock(config?.repoPath ?? repoPath)
  if (!lock || !isAlive(lock.pid)) return false
  try {
    process.kill(lock.pid, 'SIGTERM')
    return true
  } catch {
    return false
  }
}
