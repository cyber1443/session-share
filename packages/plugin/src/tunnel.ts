import { execFile, spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { STATE_DIR } from './daemon.js'

const run = promisify(execFile)

const TUNNEL_FILE = join(STATE_DIR, 'tunnel.json')
const TUNNEL_LOG = join(STATE_DIR, 'tunnel.log')
const QUICK_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/

interface TunnelRecord {
  pid: number
  url: string
  port: number
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readRecord(): TunnelRecord | null {
  try {
    return JSON.parse(readFileSync(TUNNEL_FILE, 'utf8')) as TunnelRecord
  } catch {
    return null
  }
}

/**
 * Whether the tunnel is up, from cloudflared's own word rather than a request
 * through it. Asking this machine to resolve a brand-new trycloudflare name
 * too early makes its resolver cache the miss, and then the address fails
 * here for minutes while it works for everyone else.
 */
function registered(): boolean {
  try {
    return /Registered tunnel connection/.test(readFileSync(TUNNEL_LOG, 'utf8'))
  } catch {
    return false
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * A public address for this machine's server, so a teammate on another network
 * can join without anyone setting up a VPN or a port forward.
 *
 * A Cloudflare quick tunnel: no account, nothing to configure, an
 * `https://<words>.trycloudflare.com` address that forwards to the loopback
 * port. It runs detached so it outlives this Claude Code, like the server it
 * fronts, and is reused while it still reaches the server. The address changes
 * whenever the tunnel restarts, so invites minted before then stop working --
 * for an address that never changes, run a named tunnel and pass `publicUrl`.
 */
export async function ensureTunnel(port: number): Promise<string> {
  const existing = readRecord()
  if (existing && existing.port === port && alive(existing.pid) && registered()) {
    return existing.url
  }
  if (existing && alive(existing.pid)) {
    try {
      process.kill(existing.pid)
    } catch {
      // Already going.
    }
  }

  try {
    await run('cloudflared', ['--version'], { timeout: 5000 })
  } catch {
    throw new Error(
      'Tunnelling needs cloudflared, which is not installed here. Install it (macOS: `brew install cloudflared`; others: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) and host again, or use Tailscale and pass its address as publicUrl.',
    )
  }

  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(TUNNEL_LOG, '')
  const log = openSync(TUNNEL_LOG, 'a')
  const child = spawn(
    'cloudflared',
    ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`],
    { detached: true, stdio: ['ignore', log, log] },
  )
  child.unref()
  closeSync(log)

  // cloudflared prints the address once the tunnel is registered; give it a while.
  const deadline = Date.now() + 30_000
  let url: string | null = null
  while (Date.now() < deadline) {
    const found = readFileSync(TUNNEL_LOG, 'utf8').match(QUICK_URL)
    if (found && registered()) {
      url = found[0]
      break
    }
    if (child.pid && !alive(child.pid)) break
    await wait(500)
  }
  if (!url || !child.pid) {
    if (child.pid && alive(child.pid)) process.kill(child.pid)
    throw new Error(`cloudflared did not come up with an address. Its log is at ${TUNNEL_LOG}.`)
  }
  writeFileSync(TUNNEL_FILE, `${JSON.stringify({ pid: child.pid, url, port } satisfies TunnelRecord)}\n`)
  return url
}

/** Stops the tunnel this machine started, if any. */
export function stopTunnel(): boolean {
  const record = readRecord()
  if (existsSync(TUNNEL_FILE)) rmSync(TUNNEL_FILE, { force: true })
  if (!record || !alive(record.pid)) return false
  try {
    process.kill(record.pid)
    return true
  } catch {
    return false
  }
}
