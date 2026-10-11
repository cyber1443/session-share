import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  HostMessage,
  ViewerMessage,
  type EventBody,
  type HostCommand,
  type ParticipantId,
  type SessionId,
  type TerminalAccess,
  type TerminalInfo,
  type ViewerEvent,
} from '@session-share/protocol'
import { readParticipantToken, readWsTicket, type AuthConfig } from './auth.js'
import type { Store } from './db.js'
import type { SessionService } from './service.js'

/** What a board joining late is shown of what came before. */
const SCROLLBACK_BYTES = 256 * 1024
/** How long a finished terminal stays on the board, so its last screen can be read. */
const KEEP_EXITED_MS = 10 * 60 * 1000
/** A machine that connects and says nothing is not a machine. */
const HELLO_TIMEOUT_MS = 10_000
const PING_MS = 30_000

interface HostLink {
  socket: WebSocket
  sessionId: SessionId
  participantId: ParticipantId
  access: TerminalAccess
}

interface Viewer {
  socket: WebSocket
  sessionId: SessionId
  participantId: ParticipantId
  terminalId: string | null
}

interface Live {
  info: TerminalInfo
  sessionId: SessionId
  scrollback: Buffer[]
  size: number
  viewers: Set<Viewer>
  host: HostLink | null
  exitedAt: number | null
}

class Refusal extends Error {}

/**
 * The relay between a board and a Claude Code running in a real terminal on
 * someone's machine.
 *
 * Nothing runs here. A machine opts in by connecting its terminal host -- a
 * process its own plugin starts, which does nothing unless that person turned
 * terminals on -- and this only passes bytes between it and the boards looking
 * at it, deciding on the way who may type. That decision is the whole job:
 * keys sent into a Claude with Bash on someone's laptop are as good as running
 * the commands there, so input is taken only from whoever holds the helm, and
 * the helm only goes to people in the ticket or the machine's owner.
 */
export class Terminals {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 })
  private readonly hosts = new Map<ParticipantId, HostLink>()
  private readonly live = new Map<string, Live>()
  private readonly alive = new WeakMap<WebSocket, boolean>()
  private readonly pinger: NodeJS.Timeout

  constructor(
    private readonly auth: AuthConfig,
    private readonly store: Store,
    private readonly service: SessionService,
  ) {
    this.wss.on('connection', (socket: WebSocket, request: IncomingMessage) => this.onConnection(socket, request))
    service.terminalsOf = (sessionId) => this.of(sessionId)
    /**
     * Pinged, because a tunnel drops a socket that has been quiet for a minute
     * or two, and a terminal Claude is thinking in can be quiet for longer.
     */
    this.pinger = setInterval(() => {
      for (const socket of this.wss.clients) {
        if (this.alive.get(socket) === false) {
          socket.terminate()
          continue
        }
        this.alive.set(socket, false)
        socket.ping()
      }
    }, PING_MS)
    this.pinger.unref?.()
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(request, socket, head, (ws) => this.wss.emit('connection', ws, request))
  }

  /** What boards are told: the terminals in a session, and whose machine takes one now. */
  of(sessionId: SessionId): { terminals: TerminalInfo[]; hosts: string[] } {
    const now = Date.now()
    for (const [id, term] of this.live) {
      if (term.exitedAt && now - term.exitedAt > KEEP_EXITED_MS) this.live.delete(id)
    }
    return {
      terminals: [...this.live.values()].filter((t) => t.sessionId === sessionId).map((t) => t.info),
      hosts: [...this.hosts.values()]
        .filter((h) => h.sessionId === sessionId && h.access === 'members')
        .map((h) => h.participantId),
    }
  }

  async close(): Promise<void> {
    clearInterval(this.pinger)
    for (const socket of this.wss.clients) socket.terminate()
    await new Promise<void>((resolve) => this.wss.close(() => resolve()))
  }

  // -- connections -----------------------------------------------------------

  private onConnection(socket: WebSocket, request: IncomingMessage): void {
    this.alive.set(socket, true)
    socket.on('pong', () => this.alive.set(socket, true))
    const url = new URL(request.url ?? '/term', 'http://localhost')
    if (url.searchParams.get('role') === 'host') this.acceptHost(socket)
    else this.acceptViewer(socket, url)
  }

  /**
   * A machine's terminal host. It proves which checkout it is with that
   * checkout's own participant token, sent as its first message rather than in
   * the URL, where a long-lived credential would end up in logs.
   */
  private acceptHost(socket: WebSocket): void {
    let link: HostLink | null = null
    const timer = setTimeout(() => {
      if (!link) socket.close(4001, 'no hello')
    }, HELLO_TIMEOUT_MS)

    socket.on('message', (raw) => {
      let message: HostMessage
      try {
        message = HostMessage.parse(JSON.parse(raw.toString()))
      } catch {
        return
      }
      if (!link) {
        if (message.t !== 'hello') return
        clearTimeout(timer)
        link = this.registerHost(socket, message.token, message.access)
        return
      }
      this.onHostMessage(link, message)
    })
    socket.on('close', () => {
      clearTimeout(timer)
      if (link) this.dropHost(link)
    })
    socket.on('error', () => socket.terminate())
  }

  private registerHost(socket: WebSocket, token: string, access: TerminalAccess): HostLink | null {
    const claims = readParticipantToken(this.auth, token)
    const refuse = (message: string) => {
      sendTo(socket, { t: 'refused', message })
      socket.close(4003, 'refused')
      return null
    }
    if (!claims || claims.board) return refuse('That is not a checkout token this server signed.')
    const state = this.service.state(claims.sessionId)
    const seat = state.participants.get(claims.participantId)
    if (!seat?.repoPath) return refuse('That seat has no checkout attached.')

    // One host per checkout. A second one is the same machine restarting it.
    const previous = this.hosts.get(seat.id)
    if (previous) {
      previous.socket.close(4000, 'replaced')
      this.dropHost(previous, 'the terminal host on that machine restarted')
    }
    const link: HostLink = { socket, sessionId: claims.sessionId, participantId: seat.id, access }
    this.hosts.set(seat.id, link)
    sendTo(socket, { t: 'welcome', participantId: seat.id })
    this.service.onLive?.(link.sessionId)
    return link
  }

  private dropHost(link: HostLink, reason = 'the machine running it went away'): void {
    if (this.hosts.get(link.participantId) === link) this.hosts.delete(link.participantId)
    for (const term of this.live.values()) {
      if (term.host === link && term.info.status !== 'exited') this.finish(term, null, reason)
    }
    this.service.onLive?.(link.sessionId)
  }

  private onHostMessage(link: HostLink, message: HostMessage): void {
    const term = 'terminalId' in message ? this.live.get(message.terminalId) : undefined
    if (!term || term.host !== link) return
    switch (message.t) {
      case 'started':
        term.info = { ...term.info, status: 'running' }
        this.announce(term)
        return
      case 'output': {
        const chunk = Buffer.from(message.data, 'base64')
        term.scrollback.push(chunk)
        term.size += chunk.length
        while (term.size > SCROLLBACK_BYTES && term.scrollback.length > 1) term.size -= term.scrollback.shift()!.length
        for (const viewer of term.viewers) sendTo(viewer.socket, { t: 'output', data: message.data })
        return
      }
      case 'exit':
        this.finish(term, message.code, message.reason)
        return
    }
  }

  /**
   * A board. It authenticates the way the main socket does -- a minute-long
   * ticket traded for its cookie or token -- and is then one person looking
   * at one terminal.
   */
  private acceptViewer(socket: WebSocket, url: URL): void {
    let viewer: Viewer
    try {
      viewer = this.identifyViewer(socket, url)
    } catch (error) {
      sendTo(socket, { t: 'error', message: error instanceof Error ? error.message : 'refused' })
      socket.close(4003, 'refused')
      return
    }
    socket.on('message', (raw) => {
      let message: ViewerMessage
      try {
        message = ViewerMessage.parse(JSON.parse(raw.toString()))
      } catch (error) {
        sendTo(socket, { t: 'error', message: 'That message could not be read.' })
        return
      }
      try {
        this.onViewerMessage(viewer, message)
      } catch (error) {
        sendTo(socket, { t: 'error', message: error instanceof Error ? error.message : 'failed' })
      }
    })
    socket.on('close', () => {
      if (viewer.terminalId) this.live.get(viewer.terminalId)?.viewers.delete(viewer)
    })
    socket.on('error', () => socket.terminate())
  }

  private identifyViewer(socket: WebSocket, url: URL): Viewer {
    const ticket = url.searchParams.get('ticket')
    const checked = ticket ? readWsTicket(this.auth, ticket) : null
    if (!checked?.ok) throw new Refusal('This socket needs a fresh ticket from /api/ws-ticket.')
    const claims = checked.claims
    const named = url.searchParams.get('session')
    const sessionId = claims.sessionId ?? (named ? this.store.findSessionIdByRef(named) : null)
    if (!sessionId) throw new Refusal('Say which session with ?session=.')
    if (claims.sessionId && named && this.store.findSessionIdByRef(named) !== claims.sessionId) {
      throw new Refusal('This ticket was minted for another session.')
    }
    const state = this.service.state(sessionId)
    const participantId =
      claims.participantId ?? [...state.participants.values()].find((p) => p.userId === claims.userId)?.id ?? null
    if (!participantId || !state.participants.has(participantId)) throw new Refusal('Join the session first.')
    return { socket, sessionId, participantId, terminalId: null }
  }

  private onViewerMessage(viewer: Viewer, message: ViewerMessage): void {
    if (message.t === 'open') return this.open(viewer, message)
    if (message.t === 'attach') return this.attach(viewer, message.terminalId)

    const term = viewer.terminalId ? this.live.get(viewer.terminalId) : undefined
    if (!term) throw new Refusal('Open or attach to a terminal first.')
    const state = this.service.state(term.sessionId)
    const ticket = state.tickets.get(term.info.ticketId)
    const me = viewer.participantId
    const mayDrive = () =>
      (ticket && this.service.isTicketMember(state, ticket, me)) || this.service.samePerson(state, me, term.info.hostId)

    switch (message.t) {
      case 'input': {
        if (term.info.status !== 'running') return
        if (term.info.driver === null) throw new Refusal('Claude has the helm. Take it to type.')
        if (!this.service.samePerson(state, term.info.driver, me)) {
          const who = state.participants.get(term.info.driver)?.displayName ?? 'Someone else'
          throw new Refusal(`${who} has the helm. Take it to type.`)
        }
        sendTo(term.host?.socket, { t: 'input', terminalId: term.info.id, data: message.data })
        return
      }
      case 'resize': {
        // The screen is sized for whoever is driving, or for whoever opened it while Claude is.
        const sizer = term.info.driver ?? term.info.openedBy
        if (!this.service.samePerson(state, sizer, me)) return
        if (message.cols === term.info.cols && message.rows === term.info.rows) return
        term.info = { ...term.info, cols: message.cols, rows: message.rows }
        sendTo(term.host?.socket, { t: 'resize', terminalId: term.info.id, cols: message.cols, rows: message.rows })
        this.announce(term)
        return
      }
      case 'helm': {
        if (!mayDrive()) throw new Refusal('Only people in this ticket, or whoever owns that machine, can take the helm.')
        const driver = message.to === 'me' ? me : null
        if (driver === term.info.driver) return
        term.info = { ...term.info, driver }
        this.record(term, me, { type: 'terminal.helm', terminalId: term.info.id, ticketId: term.info.ticketId, driver })
        sendTo(term.host?.socket, { t: 'helm', terminalId: term.info.id, claude: driver === null })
        this.announce(term)
        return
      }
      case 'kill': {
        if (!mayDrive()) throw new Refusal('Only people in this ticket, or whoever owns that machine, can stop it.')
        if (term.info.status === 'exited') return
        if (term.host) sendTo(term.host.socket, { t: 'kill', terminalId: term.info.id })
        else this.finish(term, null, 'stopped from the board')
        return
      }
    }
  }

  private open(viewer: Viewer, message: Extract<ViewerMessage, { t: 'open' }>): void {
    const state = this.service.state(viewer.sessionId)
    const ticket = state.tickets.get(message.ticketId)
    if (!ticket) throw new Refusal('That ticket is gone.')
    if (!this.service.isTicketMember(state, ticket, viewer.participantId)) {
      throw new Refusal('Join the ticket to open a terminal on it.')
    }
    const host = this.hosts.get(message.hostId)
    if (!host || host.sessionId !== viewer.sessionId || host.access !== 'members') {
      throw new Refusal('That machine is not taking terminals right now. Its owner turns them on with /ss:setup.')
    }
    if (!this.service.isTicketMember(state, ticket, host.participantId)) {
      throw new Refusal("A terminal runs on the machine of someone in the ticket, and that machine's owner is not.")
    }
    /**
     * One at a time per checkout: two Claudes in one working tree overwrite
     * each other, and a second terminal there would be exactly that.
     */
    const busy = [...this.live.values()].find((t) => t.host === host && t.info.status !== 'exited')
    if (busy) {
      const on = state.tickets.get(busy.info.ticketId)?.title ?? 'another ticket'
      throw new Refusal(`That checkout is already running a terminal for "${on}". Stop it first.`)
    }

    const info: TerminalInfo = {
      id: randomUUID(),
      ticketId: ticket.id,
      hostId: host.participantId,
      openedBy: viewer.participantId,
      driver: message.drive === 'me' ? viewer.participantId : null,
      status: 'starting',
      exitCode: null,
      reason: null,
      cols: message.cols,
      rows: message.rows,
      startedAt: Date.now(),
    }
    const term: Live = { info, sessionId: viewer.sessionId, scrollback: [], size: 0, viewers: new Set([viewer]), host, exitedAt: null }
    this.live.set(info.id, term)
    viewer.terminalId = info.id

    this.record(term, viewer.participantId, {
      type: 'terminal.opened',
      terminalId: info.id,
      ticketId: ticket.id,
      hostId: host.participantId,
    })
    this.record(term, viewer.participantId, {
      type: 'terminal.helm',
      terminalId: info.id,
      ticketId: ticket.id,
      driver: info.driver,
    })
    sendTo(host.socket, {
      t: 'open',
      terminalId: info.id,
      ticketId: ticket.id,
      ticketTitle: ticket.title,
      prompt: message.prompt,
      cols: info.cols,
      rows: info.rows,
    })
    sendTo(host.socket, { t: 'helm', terminalId: info.id, claude: info.driver === null })
    this.announce(term)
  }

  private attach(viewer: Viewer, terminalId: string): void {
    const term = this.live.get(terminalId)
    if (!term || term.sessionId !== viewer.sessionId) throw new Refusal('That terminal is gone.')
    if (viewer.terminalId) this.live.get(viewer.terminalId)?.viewers.delete(viewer)
    viewer.terminalId = terminalId
    term.viewers.add(viewer)
    sendTo(viewer.socket, { t: 'state', terminal: term.info })
    if (term.size > 0) sendTo(viewer.socket, { t: 'replay', data: Buffer.concat(term.scrollback).toString('base64') })
  }

  private finish(term: Live, code: number | null, reason: string | null): void {
    if (term.info.status === 'exited') return
    term.info = { ...term.info, status: 'exited', exitCode: code, reason, driver: null }
    term.exitedAt = Date.now()
    this.record(term, null, { type: 'terminal.closed', terminalId: term.info.id, ticketId: term.info.ticketId, exitCode: code })
    this.announce(term)
  }

  /** Tells the boards looking at it, and every board's list of terminals. */
  private announce(term: Live): void {
    for (const viewer of term.viewers) sendTo(viewer.socket, { t: 'state', terminal: term.info })
    this.service.onLive?.(term.sessionId)
  }

  private record(term: Live, actorId: ParticipantId | null, body: EventBody): void {
    try {
      this.service.record(term.sessionId, actorId, body)
    } catch {
      // The audit line is worth having, never worth breaking a terminal over.
    }
  }
}

function sendTo(socket: WebSocket | undefined, message: ViewerEvent | HostCommand): void {
  if (!socket || socket.readyState !== socket.OPEN) return
  socket.send(JSON.stringify(message))
}
