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
  /**
   * The session and seat the ticket was minted for, when it came from a
   * participant token. A join on this socket may only ever land there.
   */
  bound: { sessionId: SessionId; participantId: ParticipantId | null } | null
  /** Why the ticket was refused, so the first command can say so. */
  refusal: string | null
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
   * A connection with no valid ticket is anonymous and can only ping -- it used
   * to be able to send `session.join` with any name it liked, which made the
   * socket a way into any session as anyone.
   */
  private onConnection(socket: WebSocket, request: IncomingMessage): void {
    const url = new URL(request.url ?? '/ws', 'http://localhost')
    const ticket = url.searchParams.get('ticket')
    const checked = ticket ? readWsTicket(this.auth, ticket) : null
    const claims = checked?.ok ? checked.claims : null
    const user = claims ? this.store.findUserById(claims.userId) : null
    const refusal = !ticket
      ? 'This socket has no ticket. Fetch one from /api/ws-ticket and reconnect with ?ticket=.'
      : !checked?.ok
        ? checked?.reason === 'expired'
          ? 'That ws ticket expired; tickets last a minute. Fetch a fresh one and reconnect.'
          : 'That ws ticket was not signed by this server.'
        : !user
          ? 'That ws ticket names a user this server does not know.'
          : null

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
      bound: claims?.sessionId
        ? { sessionId: claims.sessionId, participantId: claims.participantId ?? null }
        : null,
      refusal,
    }
    this.connections.add(connection)

    socket.on('pong', () => {
      connection.alive = true
      // A board left open is someone watching; that is presence too.
      if (connection.ctx.participantId) this.service.seen(connection.ctx.participantId)
    })
    socket.on('message', (raw) => this.onMessage(connection, raw.toString()))
    socket.on('close', () => this.onClose(connection))
    socket.on('error', () => this.onClose(connection))
  }

  /**
   * Closing a socket says nothing about whether its participant is still here.
   * A board tab is one window onto a seat whose agent may be working away over
   * HTTP -- and recording "disconnected" when the tab closed left that agent
   * absent for good, since nothing on the HTTP side ever reconnects it, and the
   * planner then routed work around someone who was right there. Presence is
   * when a participant was last heard from, on any transport (see
   * SessionService.isPresent), so there is nothing to record here.
   */
  private onClose(connection: Connection): void {
    this.connections.delete(connection)
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

  /**
   * What a socket may not do, whatever the service would say. Null when the
   * command can go ahead.
   */
  private refuse(connection: Connection, command: ClientCommand): ServiceError | null {
    if (!connection.ctx.user) {
      return new ServiceError('unauthorized', connection.refusal ?? 'Authenticate first.')
    }
    // Opening a session has its own gate on POST /api/sessions; this is not a way round it.
    if (command.type === 'session.create') {
      return new ServiceError('forbidden', 'Open a session with POST /api/sessions.')
    }
    if (command.type === 'session.join' && connection.bound) {
      const target = this.store.findSessionIdByRef(command.sessionRef)
      if (target !== connection.bound.sessionId) {
        return new ServiceError('forbidden', 'This socket was opened for another session.')
      }
    }
    return null
  }

  private runCommand(connection: Connection, reqId: string, command: ClientCommand): void {
    const refused = this.refuse(connection, command)
    if (refused) {
      send(connection.socket, { kind: 'err', reqId, code: refused.code, message: refused.message })
      return
    }

    // The seat the ticket names, so the join lands on it rather than on any
    // seat that happens to share the user.
    if (command.type === 'session.join' && connection.bound?.participantId && !connection.ctx.participantId) {
      connection.ctx.participantId = connection.bound.participantId
    }

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
