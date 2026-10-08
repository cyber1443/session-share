import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
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
const MACHINE_FILE = join(STATE_DIR, 'machine-id')
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
  return readOrCreate(SECRET_FILE, () => randomBytes(32).toString('hex'), 0o600)
}

/**
 * Created exclusively. Two Claude Codes hosting at the same moment would
 * otherwise each write their own value, and whichever lost the race would go on
 * signing with a secret that no longer matches the file -- or the server.
 */
function readOrCreate(path: string, make: () => string, mode: number): string {
  ensureStateDir()
  if (!existsSync(path)) {
    try {
      writeFileSync(path, `${make()}\n`, { mode, flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  return readFileSync(path, 'utf8').trim()
}

/**
 * Names this machine to the server. A checkout is a path on a machine, and the
 * same absolute path on two laptops is two checkouts -- so without this the
 * server would refuse the second as "two agents in one working tree".
 */
export function machineId(): string {
  return readOrCreate(MACHINE_FILE, () => randomUUID(), 0o644)
}

/**
 * The credential that says "this request is from the host", for opening
 * sessions and minting invites. Mirrors server/auth.ts hostCredential; derived
 * from the secret so only this machine can produce it, wherever the request is
 * routed from -- a tunnel makes every guest look like loopback.
 */
export const HOST_HEADER = 'x-session-share-host'

export function hostKey(): string {
  return createHmac('sha256', hostSecret()).update('session-share/host-key').digest('hex')
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
  /** Identifies the code, so a client can tell a stale daemon from a fresh one. */
  build?: string
  /** The process answering. The only pid safe to signal; see stopDaemon. */
  pid?: number
  /** The address it is bound to: 0.0.0.0 for lan, 127.0.0.1 for loopback. */
  host?: string | null
}

/**
 * The build the server *would* be if started now.
 *
 * Deliberately the same computation the server does on itself (server/build.ts)
 * rather than a shared import: the two are bundled separately and must agree
 * across a version boundary, so each hashes the files on disk the same way.
 */
export function expectedBuild(): string {
  let entry: string
  try {
    entry = serverEntrypoint()
  } catch {
    return 'unknown'
  }

  const hash = createHash('sha256')
  try {
    const dir = dirname(entry)
    for (const name of readdirSync(dir)
      .filter((file) => file.endsWith('.js'))
      .sort()) {
      const path = join(dir, name)
      if (!statSync(path).isFile()) continue
      hash.update(name)
      hash.update(readFileSync(path))
    }
  } catch {
    return 'unknown'
  }
  return hash.digest('hex').slice(0, 12)
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
 * container and VM bridges (docker0, br-<id> for compose networks, veth pairs),
 * WireGuard. Handing a guest one of these produces an address that looks
 * plausible and refuses every connection.
 */
const SKIP_INTERFACE = /^(utun|awdl|llw|bridge|br-|vmnet|docker|veth|virbr|tun|tap|wg|tailscale|zt|ap\d)/i
const PRIVATE_LAN = /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/
/** Tailscale (and other CGNAT overlays) hand out 100.64.0.0/10. */
const TAILSCALE = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./

/**
 * The address a teammate can actually dial. `127.0.0.1` is the one address
 * guaranteed not to work for them, and the first non-internal interface is
 * frequently a VPN -- so prefer a private LAN address on a real interface, then
 * anything else on a real interface, and only then a Tailscale address. That
 * last one is skipped as a VPN in the first pass but is exactly what two people
 * on different networks who share a tailnet should dial when there is no LAN.
 */
export function lanAddress(
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): string | null {
  const real: string[] = []
  const overlay: string[] = []
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue
      if (TAILSCALE.test(address.address)) overlay.push(address.address)
      else if (!SKIP_INTERFACE.test(name)) real.push(address.address)
    }
  }
  return real.find((address) => PRIVATE_LAN.test(address)) ?? real[0] ?? overlay[0] ?? null
}

/**
 * An address the host has said to hand out instead of the one found here: a
 * tunnel (`https://x.trycloudflare.com`), a Tailscale name, a port forward.
 * Nothing on this machine can discover those, so it has to be told.
 */
export function publicUrlOverride(given?: string | null): string | null {
  const value = (given ?? process.env.SESSION_SHARE_PUBLIC_URL ?? '').trim()
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('not http')
    return url.origin
  } catch {
    throw new Error(`"${value}" is not an http(s) URL, so it cannot be put in an invite.`)
  }
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
  const wanted = expectedBuild()

  /**
   * Ask whatever is on the port, not the file. daemon.json records what was
   * true when it was written; a crash, a reboot, or two hosts racing each other
   * all leave it describing a process that is not the one answering.
   */
  const existing = readDaemon()
  for (const candidate of new Set([existing?.port, port].filter((p): p is number => Boolean(p)))) {
    const health = await probe(`http://127.0.0.1:${candidate}`)
    if (!health) continue

    if (health.serverId && health.serverId !== mine) {
      if (candidate !== port) continue // not ours, and not where we are starting one
      throw new Error(
        `Port ${port} is already serving a different session-share (id ${health.serverId}).\n` +
          'It is not this machine\'s server, so invites from it cannot be redeemed here. ' +
          `Stop it, or pick another port with SESSION_SHARE_PORT.`,
      )
    }

    /**
     * Two reasons to replace a server that is running perfectly well:
     *
     * - It is bound to loopback and a guest is expected. No amount of
     *   re-hosting changes that from the outside, and reusing it is how a
     *   host hands out `127.0.0.1` invites that work on no machine but
     *   their own.
     * - It is running code the plugin no longer ships. The daemon outlives
     *   the Claude Code that started it, so it also outlives an update --
     *   and then new tools talk to an old server, and the board it serves
     *   is the old board. Updating the plugin and seeing nothing change is
     *   the worst kind of bug, because it looks like the fix did not work.
     */
    const boundTo = health.host
      ? health.host === '127.0.0.1' || health.host === '::1'
        ? 'loopback'
        : 'lan'
      : existing?.port === candidate
        ? existing.expose
        : null
    if (health.serverId && health.build === wanted && boundTo === expose && candidate === port) {
      return adopt(port, expose, health, existing)
    }

    await stopServerAt(candidate, health)
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
    const health = await probe(loopback)
    if (health) {
      if (health.serverId && health.serverId !== mine) {
        throw new Error(
          `Something else took port ${port} while this server was starting (id ${health.serverId}). See ${LOG_FILE}`,
        )
      }
      /**
       * Fail here rather than hand back a server that is not the one asked
       * for. If an old build is still answering after it was told to stop, it
       * is holding the port and the new one could not bind -- and carrying on
       * would quietly serve yesterday's code, which is the bug this replaces.
       */
      if (health.build !== wanted) {
        throw new Error(
          [
            `Port ${port} is still answered by build ${health.build ?? 'unknown'} after a restart; the installed build is ${wanted}.`,
            `The old server did not stop${health.pid ? ` (pid ${health.pid})` : ''}. Stop it by hand and host again.`,
            `See ${LOG_FILE}`,
          ].join('\n'),
        )
      }
      return adopt(port, expose, health, null)
    }
    await sleep(250)
  }

  throw new Error(`The coordination server did not come up on port ${port}. See ${LOG_FILE}`)
}

/**
 * Records the server that is actually answering. The pid comes from the server
 * itself: when two hosts start at once, each spawns a process, one of them wins
 * the port, and the other exits -- so the pid of the child *this* call spawned
 * is a coin toss, and writing it down is how a dead pid ended up on record.
 */
function adopt(
  port: number,
  expose: 'lan' | 'loopback',
  health: Health,
  existing: DaemonInfo | null,
): DaemonInfo {
  const ip = expose === 'lan' ? lanAddress() : null
  const info: DaemonInfo = {
    port,
    url: ip ? `http://${ip}:${port}` : `http://127.0.0.1:${port}`,
    expose,
    pid: health.pid ?? existing?.pid ?? -1,
    startedAt: existing?.port === port && existing.pid === health.pid ? existing.startedAt : Date.now(),
  }
  const same =
    existing &&
    existing.port === info.port &&
    existing.url === info.url &&
    existing.expose === info.expose &&
    existing.pid === info.pid
  if (!same) writeDaemon(info)
  return same ? existing : info
}

/*
 * The process survives a change of network; the address it was reachable at
 * does not. `adopt` re-derives it every time rather than handing out
 * yesterday's DHCP lease.
 */

async function waitUntilDown(url: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await isHealthy(url, 500))) return
    await sleep(150)
  }
}

/**
 * Stops this machine's server, if it is running, and forgets it.
 *
 * Never signals a pid on the file's say-so. daemon.json outlives the process
 * it describes -- a crash or a reboot leaves it behind -- and the OS recycles
 * pids, so the number in it can belong to anything by now: an editor, a build,
 * someone's shell. The server is asked who it is first, and only a server
 * signed with this machine's key, reporting its own pid, is stopped.
 */
export async function stopDaemon(): Promise<'stopped' | 'not-running'> {
  const info = readDaemon()
  const port = info?.port ?? DEFAULT_PORT
  const health = await probe(`http://127.0.0.1:${port}`)
  let stopped = false
  if (health && health.serverId === expectedServerId()) {
    stopped = await stopServerAt(port, health, info)
  }
  forgetDaemon()
  return stopped ? 'stopped' : 'not-running'
}

async function stopServerAt(port: number, health: Health, info: DaemonInfo | null = readDaemon()): Promise<boolean> {
  /**
   * A server from before /healthz reported its pid. It answered with this
   * machine's key, so it is ours; the recorded pid is the only lead there is,
   * and only when the record is for this port.
   */
  const pid = health.pid ?? (info?.port === port ? info.pid : null)
  if (!pid || pid <= 0) return false
  try {
    process.kill(pid)
  } catch {
    return false
  }
  await waitUntilDown(`http://127.0.0.1:${port}`)
  return true
}

function forgetDaemon(): void {
  rmSync(DAEMON_FILE, { force: true })
}

function openLog(): number {
  return openSync(LOG_FILE, 'a')
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export const paths = { STATE_DIR, DAEMON_FILE, SECRET_FILE, MACHINE_FILE, DB_FILE, LOG_FILE }
