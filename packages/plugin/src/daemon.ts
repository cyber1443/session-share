import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The host's coordination server, started and kept alive on their behalf.
 *
 * The point of peer mode is that nobody runs infrastructure: the first person
 * to host a session gets a server as a side effect, detached from the Claude
 * Code that asked for it so closing that terminal does not end the session.
 */
export const STATE_DIR = join(homedir(), '.session-share')
const DAEMON_FILE = join(STATE_DIR, 'daemon.json')
const SECRET_FILE = join(STATE_DIR, 'secret')
const DB_FILE = join(STATE_DIR, 'sessions.db')
const LOG_FILE = join(STATE_DIR, 'server.log')

export const DEFAULT_PORT = 4310

export interface DaemonInfo {
  port: number
  /** What a guest should dial: the LAN address, not loopback. */
  url: string
  pid: number
  startedAt: number
}

function ensureStateDir(): void {
  mkdirSync(STATE_DIR, { recursive: true })
}

/**
 * Persisted so restarts do not invalidate every invite and every attached
 * checkout. A regenerated secret silently logs everyone out.
 */
export function hostSecret(): string {
  ensureStateDir()
  if (existsSync(SECRET_FILE)) return readFileSync(SECRET_FILE, 'utf8').trim()
  const secret = randomBytes(32).toString('hex')
  writeFileSync(SECRET_FILE, `${secret}\n`, { mode: 0o600 })
  return secret
}

export function readDaemon(): DaemonInfo | null {
  if (!existsSync(DAEMON_FILE)) return null
  try {
    return JSON.parse(readFileSync(DAEMON_FILE, 'utf8')) as DaemonInfo
  } catch {
    return null
  }
}

function writeDaemon(info: DaemonInfo): void {
  ensureStateDir()
  writeFileSync(DAEMON_FILE, `${JSON.stringify(info, null, 2)}\n`)
}

export async function isHealthy(url: string, timeoutMs = 1200): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(new URL('/healthz', url), { signal: controller.signal })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * First non-internal IPv4 address. Guests need something they can actually
 * dial, and `127.0.0.1` is the one address guaranteed not to work for them.
 */
export function lanAddress(): string | null {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address
    }
  }
  return null
}

function serverEntrypoint(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    process.env.SESSION_SHARE_SERVER_ENTRY,
    // Installed plugin: this file is bundle/mcp.js, the server is bundle/server.
    resolve(here, 'server/index.js'),
    // Unbundled build inside the plugin directory.
    resolve(here, '../server/index.js'),
    // In the monorepo: packages/plugin/dist -> packages/server/dist.
    resolve(here, '../../server/dist/index.js'),
  ].filter((value): value is string => Boolean(value))

  const found = candidates.find((candidate) => existsSync(candidate))
  if (!found) {
    throw new Error(
      `Could not find the coordination server. Looked in:\n${candidates.join('\n')}\nBuild it with: pnpm build`,
    )
  }
  return found
}

export interface StartOptions {
  port?: number
  /** 'lan' lets teammates on the same network connect; 'loopback' is this machine only. */
  expose?: 'lan' | 'loopback'
}

/**
 * Starts the server if it is not already up, and returns how to reach it.
 * Idempotent: hosting a second session reuses the running daemon.
 */
export async function ensureDaemon(options: StartOptions = {}): Promise<DaemonInfo> {
  const port = options.port ?? DEFAULT_PORT
  const expose = options.expose ?? 'lan'

  const existing = readDaemon()
  if (existing && (await isHealthy(`http://127.0.0.1:${existing.port}`))) return existing

  ensureStateDir()
  const out = openLog()

  const child = spawn(process.execPath, [serverEntrypoint()], {
    detached: true,
    stdio: ['ignore', out, out],
    env: {
      ...process.env,
      SESSION_SHARE_MODE: 'peer',
      SESSION_SHARE_SECRET: hostSecret(),
      SESSION_SHARE_DB: DB_FILE,
      PORT: String(port),
      HOST: expose === 'lan' ? '0.0.0.0' : '127.0.0.1',
    },
  })
  child.unref()

  const loopback = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (await isHealthy(loopback)) {
      const ip = expose === 'lan' ? lanAddress() : null
      const info: DaemonInfo = {
        port,
        url: ip ? `http://${ip}:${port}` : loopback,
        pid: child.pid ?? -1,
        startedAt: Date.now(),
      }
      writeDaemon(info)
      return info
    }
    await sleep(250)
  }

  throw new Error(`The coordination server did not come up on port ${port}. See ${LOG_FILE}`)
}

export function stopDaemon(): boolean {
  const info = readDaemon()
  if (!info) return false
  try {
    process.kill(info.pid)
    return true
  } catch {
    return false
  }
}

function openLog(): number {
  return openSync(LOG_FILE, 'a')
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export const paths = { STATE_DIR, DAEMON_FILE, SECRET_FILE, DB_FILE, LOG_FILE }
