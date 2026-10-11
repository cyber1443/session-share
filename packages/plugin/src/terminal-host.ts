import { fileURLToPath } from 'node:url'
import { HostCommand, type HostMessage } from '@session-share/protocol'
import { BUILDING_TOOLS } from './autopilot.js'
import { isBusy, markTerminal } from './busy.js'
import { readConfig, type SessionConfig } from './config.js'
import { readInbox } from './inbox.js'
import { readPreferences } from './preferences.js'
import { spawnPty, type Pty } from './pty.js'
import { buildOf, clearLock, isAlive, readLock, writeLock } from './terminal-launch.js'

/**
 * Runs board terminals on this machine.
 *
 * One per checkout, started by the plugin when its owner has turned terminals
 * on, and connected to the coordination server for as long as the checkout is
 * in a session. The server tells it to open a terminal for a ticket; it starts
 * Claude Code in a pseudo-terminal in this checkout and streams the screen
 * back. It does nothing on its own initiative but one thing: while Claude has
 * the helm, work queued for this seat is typed in as the agent goes idle --
 * the same `/ss:go` a person would type.
 */

const REPO = process.env.SESSION_SHARE_REPO ?? process.cwd()
const SELF = fileURLToPath(import.meta.url)
const BUILD = buildOf(SELF)

/** How often a terminal Claude is driving is checked for queued work. */
const NUDGE_POLL_MS = 4_000
/** After typing `/ss:go`, how long before doing it again if nothing took it. */
const NUDGE_AGAIN_MS = 90_000
const RECONNECT_MIN_MS = 1_000
const RECONNECT_MAX_MS = 30_000
/**
 * A server unreachable this long has been stopped, not interrupted. The host
 * goes too; the plugin starts a new one the next time Claude Code opens here.
 */
const GIVE_UP_MS = 6 * 60 * 60 * 1000

interface Running {
  id: string
  pty: Pty
  claudeDrives: boolean
  lastNudge: number
  /** Stopped on purpose, so its hang-up exit code is not reported as a failure. */
  stopped: boolean
}

const terminals = new Map<string, Running>()
let socket: WebSocket | null = null
let backoff = RECONNECT_MIN_MS
let stopping = false
/** When the server was last reachable. */
let lastConnected = Date.now()
/** Sockets that got as far as opening. */
const welcomed = new WeakSet<WebSocket>()

const log = (line: string) => process.stdout.write(`${new Date().toISOString()} [${process.pid}] ${line}\n`)

function send(message: HostMessage): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
}

function config(): SessionConfig | null {
  const found = readConfig(REPO)
  return found?.participantToken ? found : null
}

function termUrl(serverUrl: string): string {
  const url = new URL('/term', serverUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('role', 'host')
  return url.toString()
}

function connect(): void {
  if (stopping) return
  const cfg = config()
  if (!cfg) return shutdown('this checkout is no longer in a session')
  if (readPreferences().terminal === 'off') return shutdown('terminals were turned off')

  const ws = new WebSocket(termUrl(cfg.serverUrl))
  socket = ws
  ws.onopen = () => {
    backoff = RECONNECT_MIN_MS
    lastConnected = Date.now()
    welcomed.add(ws)
    ws.send(JSON.stringify({ t: 'hello', token: cfg.participantToken!, access: readPreferences().terminal }))
  }
  ws.onmessage = (event) => {
    let command: HostCommand
    try {
      command = HostCommand.parse(JSON.parse(String(event.data)))
    } catch {
      return
    }
    onCommand(cfg, command)
  }
  ws.onclose = (event) => {
    if (socket === ws) socket = null
    // Reachable until this moment, however long ago the connection opened.
    if (ws.readyState === WebSocket.CLOSED && welcomed.has(ws)) lastConnected = Date.now()
    // Another host took this checkout's place; two would fight over it.
    if (event.code === 4000) return shutdown('another terminal host took over this checkout')
    if (stopping) return
    if (Date.now() - lastConnected > GIVE_UP_MS && terminals.size === 0) {
      return shutdown('the server has been unreachable for hours')
    }
    setTimeout(connect, backoff)
    backoff = Math.min(backoff * 2, RECONNECT_MAX_MS)
  }
  ws.onerror = () => undefined
}

function onCommand(cfg: SessionConfig, command: HostCommand): void {
  switch (command.t) {
    case 'welcome':
      log(`connected to ${cfg.serverUrl} as ${command.participantId}`)
      return
    case 'refused':
      log(`refused: ${command.message}`)
      backoff = RECONNECT_MAX_MS
      return
    case 'open':
      return open(cfg, command)
    case 'input':
      terminals.get(command.terminalId)?.pty.write(Buffer.from(command.data, 'base64'))
      return
    case 'resize':
      terminals.get(command.terminalId)?.pty.resize(command.cols, command.rows)
      return
    case 'helm': {
      const term = terminals.get(command.terminalId)
      if (term) term.claudeDrives = command.claude
      return
    }
    case 'kill': {
      const term = terminals.get(command.terminalId)
      if (term) {
        term.stopped = true
        term.pty.kill()
      }
      return
    }
  }
}

function open(cfg: SessionConfig, command: Extract<HostCommand, { t: 'open' }>): void {
  if (terminals.size > 0) {
    send({ t: 'exit', terminalId: command.terminalId, code: null, reason: 'this checkout is already running a terminal' })
    return
  }
  /**
   * The same tools and permission mode an unattended run gets, so a terminal
   * Claude is driving does not stop dead at a permission prompt nobody is
   * there to answer. Whoever takes the helm can answer anything beyond them.
   */
  const args = ['--permission-mode', 'acceptEdits', '--allowedTools', ...BUILDING_TOOLS]
  if (command.prompt) {
    // First, so the variadic --allowedTools does not swallow it as a tool name.
    args.unshift(`This terminal was opened from the board for the ticket "${command.ticketTitle}" (${command.ticketId}).\n\n${command.prompt}`)
  }
  log(`opening ${command.terminalId} for "${command.ticketTitle}"`)
  const pty = spawnPty({
    command: process.env.SESSION_SHARE_CLAUDE ?? 'claude',
    args,
    cwd: cfg.repoPath,
    cols: command.cols,
    rows: command.rows,
    env: { ...process.env, SESSION_SHARE_AUTOPILOT: undefined, SESSION_SHARE_TERMINAL: command.terminalId },
    onData: (data) => send({ t: 'output', terminalId: command.terminalId, data: data.toString('base64') }),
    onExit: (code, said) => {
      const reason = terminals.get(command.terminalId)?.stopped ? 'stopped from the board' : said
      terminals.delete(command.terminalId)
      if (terminals.size === 0) markTerminal(cfg.repoPath, false)
      log(`${command.terminalId} exited ${code}${reason ? `: ${reason}` : ''}`)
      send({ t: 'exit', terminalId: command.terminalId, code, reason })
    },
  })
  terminals.set(command.terminalId, { id: command.terminalId, pty, claudeDrives: false, lastNudge: 0, stopped: false })
  markTerminal(cfg.repoPath, true)
  send({ t: 'started', terminalId: command.terminalId })
}

/**
 * While Claude has the helm and is idle, work waiting for this seat is typed
 * in. Never while it is mid-turn -- the Stop hook hands it the next one then --
 * and never twice in quick succession, in case nothing took the first.
 */
async function nudge(): Promise<void> {
  const cfg = config()
  if (!cfg) return
  for (const term of terminals.values()) {
    if (!term.claudeDrives || isBusy(cfg.repoPath)) continue
    if (Date.now() - term.lastNudge < NUDGE_AGAIN_MS) continue
    const inbox = await readInbox(cfg, 2000).catch(() => null)
    if (!inbox || inbox.messages.length === 0) continue
    term.lastNudge = Date.now()
    log(`${term.id}: ${inbox.messages.length} instruction(s) waiting, handing them to Claude`)
    term.pty.write('/ss:go')
    // The Enter on its own, so the line is in the input before it is submitted.
    setTimeout(() => term.pty.write('\r'), 200)
  }
}

function shutdown(why: string): void {
  if (stopping) return
  stopping = true
  log(`stopping: ${why}`)
  for (const term of terminals.values()) term.pty.kill()
  markTerminal(REPO, false)
  clearLock(REPO, process.pid)
  socket?.close()
  // Long enough for a hung-up Claude to go, and for the last exit to be sent.
  setTimeout(() => process.exit(0), terminals.size > 0 ? 4_000 : 100).unref()
}

const existing = readLock(REPO)
if (existing && existing.pid !== process.pid && isAlive(existing.pid) && existing.build === BUILD) {
  log('another terminal host already runs this checkout')
  process.exit(0)
}
writeLock(REPO, { pid: process.pid, build: BUILD })
process.on('SIGTERM', () => shutdown('asked to stop'))
process.on('SIGINT', () => shutdown('interrupted'))
setInterval(() => void nudge(), NUDGE_POLL_MS)
connect()
log(`terminal host for ${REPO}`)
