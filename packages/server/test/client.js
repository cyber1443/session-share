import { WebSocket } from 'ws'
import { HOST_HEADER, hostCredential, issueWsTicket, peerUserId, upsertUser } from '../dist/auth.js'

/**
 * The app the clients talk to. A socket is anonymous until it presents a ticket,
 * and an anonymous socket can do nothing -- so a client that wants to join as
 * someone needs a ticket for them, which only the server's own key can mint.
 */
let app = null
export function useApp(instance) {
  app = instance
}

/** A ws ticket for a peer user, minted the way /api/ws-ticket would. */
export function ticketFor(login, displayName = login) {
  const user = upsertUser(app.store, {
    githubId: peerUserId(login),
    githubLogin: login,
    displayName,
    avatarUrl: null,
  })
  return issueWsTicket(app.auth, user.id)
}

/**
 * Minimal test client: one socket, promise-per-reqId, and a running list of
 * everything the server pushed. Mirrors what the plugin and the board will do.
 */
export class TestClient {
  constructor(url) {
    this.url = url
    this.socket = null
    this.pending = new Map()
    this.events = []
    this.frames = []
    this.syncs = []
    this.nextId = 0
  }

  async connect(ticket = null) {
    this.socket = new WebSocket(ticket ? `${this.url}?ticket=${encodeURIComponent(ticket)}` : this.url)
    await new Promise((resolve, reject) => {
      this.socket.once('open', resolve)
      this.socket.once('error', reject)
    })
    this.socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString())
      switch (message.kind) {
        case 'ack': {
          this.pending.get(message.reqId)?.resolve(message.data)
          this.pending.delete(message.reqId)
          break
        }
        case 'err': {
          const error = new Error(message.message)
          error.code = message.code
          this.pending.get(message.reqId)?.reject(error)
          this.pending.delete(message.reqId)
          break
        }
        case 'event':
          this.events.push(message.event)
          break
        case 'sync':
          this.syncs.push(message)
          break
        case 'frame':
          this.frames.push(message.frame)
          break
      }
    })
    return this
  }

  /**
   * Sessions are opened over HTTP by the host, and a join is only honoured on a
   * socket that authenticated as that person. Both are done here so the tests
   * read as the commands they mean.
   */
  async send(command) {
    if (app && command.type === 'session.create') return this.createOverHttp(command)
    if (app && command.type === 'session.join' && command.githubLogin && this.as !== command.githubLogin) {
      await this.close()
      await this.connect(ticketFor(command.githubLogin, command.displayName ?? command.githubLogin))
      this.as = command.githubLogin
    }
    return this.raw(command)
  }

  async createOverHttp(command) {
    const base = this.url.replace(/^ws/, 'http').replace(/\/ws$/, '')
    const { type: _type, ...body } = command
    const response = await fetch(new URL('/api/sessions', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json', [HOST_HEADER]: hostCredential(app.auth) },
      body: JSON.stringify(body),
    })
    const payload = await response.json()
    if (!response.ok) {
      const error = new Error(payload.message ?? payload.error)
      error.code = payload.error
      throw error
    }
    return payload
  }

  /** Exactly what is given, on the socket as it stands. */
  raw(command) {
    const reqId = `r${this.nextId++}`
    const promise = new Promise((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject })
      setTimeout(() => {
        if (this.pending.delete(reqId)) reject(new Error(`timeout: ${command.type}`))
      }, 4000)
    })
    this.socket.send(JSON.stringify({ kind: 'cmd', v: 1, reqId, command }))
    return promise
  }

  frame(frame) {
    this.socket.send(JSON.stringify({ kind: 'frame', v: 1, frame }))
  }

  eventsOfType(type) {
    return this.events.filter((e) => e.body.type === type)
  }

  async close() {
    if (!this.socket || this.socket.readyState === WebSocket.CLOSED) return
    await new Promise((resolve) => {
      this.socket.once('close', resolve)
      this.socket.close()
    })
  }
}

/** Commands are fire-and-forget over the wire; give the server a tick to settle. */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 60))

export async function expectError(promise, code) {
  try {
    await promise
  } catch (error) {
    if (code && error.code !== code) {
      throw new Error(`expected error code ${code}, got ${error.code}: ${error.message}`)
    }
    return error
  }
  throw new Error('expected the command to be rejected, but it succeeded')
}
