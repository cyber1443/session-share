import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { createHmac, randomBytes } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isLoopbackUrl } from '@session-share/protocol'

/**
 * The host's coordination server, started and kept alive on their behalf.
 *
 * The point of peer mode is that nobody runs infrastructure: the first person
 * to host a session gets a server as a side effect, detached from the Claude
 * Code that asked for it so closing that terminal does not end the session.
 */
export const STATE_DIR = process.env.SESSION_SHARE_HOME ?? join(homedir(), '.session-share')
const DAEMON_FILE = join(STATE_DIR, 'daemon.json')
const SECRET_FILE = join(STATE_DIR, 'secret')
const DB_FILE = join(STATE_DIR, 'sessions.db')
const LOG_FILE = join(STATE_DIR, 'server.log')

export const DEFAULT_PORT = Number(process.env.SESSION_SHARE_PORT ?? 4310)

export interface DaemonInfo {
  port: number
  /** What a guest should dial: the LAN address, not loopback. */
  url: string
  /** What the running process is actually bound to. */
  expose: 'lan' | 'loopback'
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

/**
 * What our own server's `/healthz` will report, computed from the secret on
 * this machine. Anything else answering on the port is somebody else's process,
 * and adopting it would mean minting invites nobody can redeem.
 */
export function expectedServerId(): string {
  return createHmac('sha256', hostSecret())
    .update('session-share/server-id')
    .digest('hex')
    .slice(0, 16)
}

export function readDaemon(): DaemonInfo | null {
  if (!existsSync(DAEMON_FILE)) return null
  try {
    const info = JSON.parse(readFileSync(DAEMON_FILE, 'utf8')) as DaemonInfo
    // Written before `expose` existed: a loopback url can only have meant loopback.
    return { ...info, expose: info.expose ?? (isLoopbackUrl(info.url) ? 'loopback' : 'lan') }
  } catch {
    return null
  }
}

function writeDaemon(info: DaemonInfo): void {
  ensureStateDir()
  writeFileSync(DAEMON_FILE, `${JSON.stringify(info, null, 2)}\n`)
}

export interface Health {
  ok: boolean
  mode?: string
  /** Identifies the signing key, so a client can tell two servers apart. */
  serverId?: string
}

/** Health plus identity, or null when nothing answered. */
export async function probe(url: string, timeoutMs = 1500): Promise<Health | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(new URL('/healthz', url), { signal: controller.signal })
    if (!response.ok) return null
    return (await response.json()) as Health
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export async function isHealthy(url: string, timeoutMs = 1200): Promise<boolean> {
  return (await probe(url, timeoutMs)) !== null
}

/**
 * Interfaces that exist but are never the answer: VPN tunnels, AirDrop links,
 * container and VM bridges. Handing a guest one of these produces an address
 * that looks plausible and refuses every connection.
 */
const SKIP_INTERFACE = /^(utun|awdl|llw|bridge|vmnet|docker|veth|tun|tap|ap\d)/i
const PRIVATE_LAN = /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/

/**
 * The address a teammate on the same network can actually dial. `127.0.0.1` is
 * the one address guaranteed not to work for them, and the first non-internal
 * interface is frequently a VPN -- so prefer a private LAN address on a real
 * interface, and only fall back to whatever is left.
 */
export function lanAddress(): string | null {
  const candidates: string[] = []
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    if (SKIP_INTERFACE.test(name)) continue
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue
      candidates.push(address.address)
    }
  }
  return candidates.find((address) => PRIVATE_LAN.test(address)) ?? candidates[0] ?? null
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

  const mine = expectedServerId()
  const existing = readDaemon()
  if (existing) {
    const health = await probe(`http://127.0.0.1:${existing.port}`)
    // No serverId at all means a server from before fingerprints: ours, but old.
    if (health && (!health.serverId || health.serverId === mine)) {
      /**
       * A running server bound to loopback cannot serve a guest, and no amount
       * of re-hosting changes that from the outside -- so a mismatch restarts
       * it. Reusing it regardless is how a host ends up handing out
       * `127.0.0.1` invites that fail on every machine but their own.
       */
      if (health.serverId && existing.expose === expose) return refreshAddress(existing)

      stopDaemon()
      await waitUntilDown(`http://127.0.0.1:${existing.port}`)
    }
  }

  /**
   * Something answering on the port that is not ours would be adopted silently
   * by a plain health check, and every invite minted afterwards would be signed
   * by a key the other process does not have.
   */
  const squatter = await probe(`http://127.0.0.1:${port}`)
  if (squatter && squatter.serverId !== mine) {
    throw new Error(
      `Port ${port} is already serving a different session-share (id ${squatter.serverId ?? 'unknown'}).\n` +
        'It is not this machine\'s server, so invites from it cannot be redeemed here. ' +
        `Stop it, or pick another port with SESSION_SHARE_PORT.`,
    )
  }

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
        expose,
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

/**
 * The process survives a change of network; the address it was reachable at
 * does not. Re-derive it rather than handing out yesterday's DHCP lease.
 */
function refreshAddress(info: DaemonInfo): DaemonInfo {
  if (info.expose !== 'lan') return info
  const ip = lanAddress()
  const url = ip ? `http://${ip}:${info.port}` : `http://127.0.0.1:${info.port}`
  if (url === info.url) return info
  const updated = { ...info, url }
  writeDaemon(updated)
  return updated
}

async function waitUntilDown(url: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await isHealthy(url, 500))) return
    await sleep(150)
  }
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
