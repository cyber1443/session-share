import { WebSocket } from 'ws'

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

  async connect() {
    this.socket = new WebSocket(this.url)
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

  send(command) {
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
    if (!this.socket) return
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
