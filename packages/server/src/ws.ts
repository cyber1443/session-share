import type { IncomingMessage, Server } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { readWsTicket, type AuthConfig } from './auth.js'
import type { Store } from './db.js'
import {
  type ActivityFrame,
  type ClientCommand,
  type EventEnvelope,
  type ParticipantId,
  type ServerMessage,
  type SessionId,
  ClientMessage,
} from '@session-share/protocol'
import { ServiceError, type CommandContext, type SessionService } from './service.js'

/** Events per sync batch. Keeps a long backlog off one giant frame. */
const SYNC_BATCH = 500
const HEARTBEAT_MS = 30_000

interface Connection {
  socket: WebSocket
  ctx: CommandContext
  alive: boolean
}

export class Gateway {
  private readonly connections = new Set<Connection>()
  private readonly wss: WebSocketServer
  private heartbeat: NodeJS.Timeout | null = null
  private service!: SessionService

  constructor(
    server: Server,
    path: string,
    private readonly auth: AuthConfig,
    private readonly store: Store,
  ) {
    this.wss = new WebSocketServer({ server, path })
  }

  attach(service: SessionService): void {
    this.service = service
    this.wss.on('connection', (socket, request) => this.onConnection(socket, request))
    this.heartbeat = setInterval(() => this.sweep(), HEARTBEAT_MS)
  }

  /** Fan a persisted event out to everyone in the session. */
  broadcast(sessionId: SessionId, envelope: EventEnvelope): void {
    const message: ServerMessage = { kind: 'event', event: envelope }
    for (const connection of this.connections) {
      if (connection.ctx.sessionId === sessionId) send(connection.socket, message)
    }
  }

  /**
   * Relay ephemeral activity to everyone but the sender. This is the ws-fanout
   * ActivityTransport; nothing here is stored or ordered, which is what makes
   * swapping in a WebRTC mesh later a transport change and nothing more.
   */
  relayFrame(sessionId: SessionId, from: ParticipantId, frame: ActivityFrame): void {
    const message: ServerMessage = { kind: 'frame', frame }
    for (const connection of this.connections) {
      if (connection.ctx.sessionId !== sessionId) continue
      if (connection.ctx.participantId === from) continue
      send(connection.socket, message)
    }
  }

  async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat)
    for (const connection of this.connections) connection.socket.terminate()
    this.connections.clear()
    await new Promise<void>((resolve) => this.wss.close(() => resolve()))
  }

  // -- internals -----------------------------------------------------------

  /**
   * A cross-origin WebSocket cannot carry the session cookie over plain http,
   * so the board trades the cookie for a 60-second ticket and presents that.
   * A connection with no valid ticket is anonymous and can only ping.
   */
  private onConnection(socket: WebSocket, request: IncomingMessage): void {
    const url = new URL(request.url ?? '/ws', 'http://localhost')
    const ticket = url.searchParams.get('ticket')
    const claims = ticket ? readWsTicket(this.auth, ticket) : null
    const user = claims ? this.store.findUserById(claims.userId) : null

    const connection: Connection = {
      socket,
      ctx: {
        sessionId: null,
        participantId: null,
        user: user
          ? {
              id: user.id,
              githubLogin: user.githubLogin,
              displayName: user.displayName,
              avatarUrl: user.avatarUrl,
            }
          : null,
      },
      alive: true,
    }
    this.connections.add(connection)

    socket.on('pong', () => {
      connection.alive = true
    })
    socket.on('message', (raw) => this.onMessage(connection, raw.toString()))
    socket.on('close', () => this.onClose(connection))
    socket.on('error', () => this.onClose(connection))
  }

  private onClose(connection: Connection): void {
    if (!this.connections.delete(connection)) return
    const { sessionId, participantId } = connection.ctx
    if (!sessionId || !participantId) return

    // Another tab or a reconnect may still hold the same participant.
    const stillHere = [...this.connections].some(
      (other) => other.ctx.participantId === participantId,
    )
    if (!stillHere) this.service.markDisconnected(sessionId, participantId)
  }

  private onMessage(connection: Connection, raw: string): void {
    let parsed: ClientMessage
    try {
      parsed = ClientMessage.parse(JSON.parse(raw))
    } catch (error) {
      /**
       * Answer the request that caused this, not a blank one. A rejection the
       * client cannot correlate leaves its promise pending forever, which shows
       * up as a UI that hangs rather than one that reports a problem.
       */
      send(connection.socket, {
        kind: 'err',
        reqId: reqIdOf(raw),
        code: 'bad_request',
        message: error instanceof Error ? error.message : 'unparseable message',
      })
      return
    }

    if (parsed.kind === 'ping') {
      send(connection.socket, { kind: 'pong', ts: parsed.ts })
      return
    }

    if (parsed.kind === 'frame') {
      const { sessionId, participantId } = connection.ctx
      if (!sessionId || !participantId) return // frames before join are noise
      this.relayFrame(sessionId, participantId, parsed.frame)
      return
    }

    this.runCommand(connection, parsed.reqId, parsed.command)
  }

  private runCommand(connection: Connection, reqId: string, command: ClientCommand): void {
    try {
      const data = this.service.handle(command as never, connection.ctx)
      send(connection.socket, { kind: 'ack', reqId, data })

      // A resuming client asked for a backlog rather than a snapshot.
      if (command.type === 'session.join' && command.fromSeq !== null) {
        this.sendSync(connection, command.fromSeq)
      } else if (command.type === 'session.sync') {
        this.sendSync(connection, command.fromSeq)
      }
    } catch (error) {
      if (error instanceof ServiceError) {
        send(connection.socket, {
          kind: 'err',
          reqId,
          code: error.code,
          message: error.message,
        })
        return
      }
      send(connection.socket, {
        kind: 'err',
        reqId,
        code: 'internal',
        message: error instanceof Error ? error.message : 'internal error',
      })
    }
  }

  /**
   * Ordered backlog after a reconnect, in batches. `more: true` tells the client
   * to keep buffering live events until the final batch arrives, so a late
   * event can never be applied before an older one it depends on.
   */
  private sendSync(connection: Connection, fromSeq: number): void {
    const sessionId = connection.ctx.sessionId
    if (!sessionId) return

    let cursor = fromSeq
    for (;;) {
      const events = this.service.readEvents(sessionId, cursor, SYNC_BATCH)
      const last = events[events.length - 1]
      const more = events.length === SYNC_BATCH
      send(connection.socket, {
        kind: 'sync',
        events,
        upToSeq: last?.seq ?? Math.max(fromSeq - 1, -1),
        more,
      })
      if (!more || !last) return
      cursor = last.seq + 1
    }
  }

  private sweep(): void {
    for (const connection of this.connections) {
      if (!connection.alive) {
        connection.socket.terminate()
        this.onClose(connection)
        continue
      }
      connection.alive = false
      connection.socket.ping()
    }
  }
}

/** Best-effort reqId recovery from a message that failed validation. */
function reqIdOf(raw: string): string {
  try {
    const value = JSON.parse(raw) as { reqId?: unknown }
    return typeof value.reqId === 'string' ? value.reqId : ''
  } catch {
    return ''
  }
}

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState !== socket.OPEN) return
  socket.send(JSON.stringify(message))
}
