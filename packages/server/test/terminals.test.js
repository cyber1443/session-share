import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { WebSocket } from 'ws'
import { ClientCommand } from '@session-share/protocol'
import { issueParticipantToken, issueWsTicket } from '../dist/auth.js'
import { createApp } from '../dist/index.js'

/**
 * The terminal relay, end to end over real sockets: a stand-in for a
 * machine's terminal host on one side, boards on the other. What matters is
 * who may type into someone's machine, so most of this is about refusals.
 */

const REPO = { owner: 'acme', name: 'web', baseBranch: 'main', remoteUrl: 'x' }

let app
let base
let sessionId
const seats = {}

const run = (ctx, command) => app.service.handle(ClientCommand.parse(command), ctx)

before(async () => {
  app = createApp({ dbPath: ':memory:' })
  const url = await app.listen(0)
  base = url.replace(/^http/, 'ws')
  ;({ sessionId } = run(
    { sessionId: null, participantId: null },
    { type: 'session.create', slug: 'term', title: 'Terminals', repo: REPO },
  ))
  for (const login of ['alice', 'bob', 'carol']) {
    const user = { id: login, githubLogin: login, displayName: login, avatarUrl: null }
    const ctx = { sessionId: null, participantId: null, user }
    run(ctx, { type: 'session.join', sessionRef: 'term', repoPath: `/tmp/${login}`, fromSeq: 0 })
    seats[login] = ctx
  }
})

after(async () => {
  await app.close()
})

/** A socket and everything it has been sent, with a way to wait for the next match. */
async function socket(url) {
  const ws = new WebSocket(url)
  const inbox = []
  const waiters = []
  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString())
    inbox.push(message)
    for (const waiter of [...waiters]) {
      if (waiter.match(message)) {
        waiters.splice(waiters.indexOf(waiter), 1)
        waiter.resolve(message)
      }
    }
  })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  return {
    ws,
    inbox,
    send: (message) => ws.send(JSON.stringify(message)),
    next(match, label = 'a message') {
      const seen = inbox.find(match)
      if (seen) {
        inbox.splice(inbox.indexOf(seen), 1)
        return Promise.resolve(seen)
      }
      return new Promise((resolve, reject) => {
        const waiter = {
          match: (m) => {
            if (!match(m)) return false
            inbox.splice(inbox.indexOf(m), 1)
            return true
          },
          resolve,
        }
        waiters.push(waiter)
        setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 3000)
      })
    },
    close: () =>
      new Promise((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) return resolve()
        ws.once('close', resolve)
        ws.close()
      }),
  }
}

async function host(login, access = 'members') {
  const conn = await socket(`${base}/term?role=host`)
  const ctx = seats[login]
  conn.send({
    t: 'hello',
    token: issueParticipantToken(app.auth, { participantId: ctx.participantId, sessionId, userId: login }),
    access,
  })
  await conn.next((m) => m.t === 'welcome' || m.t === 'refused', 'welcome')
  return conn
}

async function viewer(login) {
  const ctx = seats[login]
  const ticket = issueWsTicket(app.auth, login, { sessionId, participantId: ctx.participantId })
  return socket(`${base}/term?ticket=${encodeURIComponent(ticket)}`)
}

const error = (conn) => conn.next((m) => m.t === 'error', 'an error')
const stateOf = (conn, check = () => true) => conn.next((m) => m.t === 'state' && check(m.terminal), 'a state')
const b64 = (text) => Buffer.from(text).toString('base64')
const audit = (type) => app.store.readEvents(sessionId, 0, 10_000).filter((e) => e.body.type === type)

describe('terminals', () => {
  let ticket
  let machine
  let terminalId

  it('lists a machine that takes terminals, and not one that does not', async () => {
    ;({ ticket } = run(seats.alice, { type: 'ticket.create', title: 'Search page' }))
    machine = await host('alice')
    const off = await host('carol', 'off')
    const live = app.service.snapshotOf(sessionId)
    assert.deepEqual(live.terminalHosts, [seats.alice.participantId])
    await off.close()
  })

  it('refuses to open a terminal for someone not in the ticket', async () => {
    const bob = await viewer('bob')
    bob.send({ t: 'open', ticketId: ticket.id, hostId: seats.alice.participantId, cols: 100, rows: 30 })
    assert.match((await error(bob)).message, /Join the ticket/)
    await bob.close()
  })

  it('refuses a machine whose owner is not in the ticket', async () => {
    run(seats.bob, { type: 'ticket.join', ticketId: ticket.id })
    const bobHost = await host('bob')
    const otherTicket = run(seats.carol, { type: 'ticket.create', title: 'Elsewhere' }).ticket
    run(seats.bob, { type: 'ticket.join', ticketId: otherTicket.id })
    const carol = await viewer('carol')
    // Carol is in her own ticket; alice's machine is not.
    carol.send({ t: 'open', ticketId: otherTicket.id, hostId: seats.alice.participantId, cols: 100, rows: 30 })
    assert.match((await error(carol)).message, /machine's owner is not/)
    await carol.close()
    await bobHost.close()
  })

  it('opens on a member machine and streams both ways for whoever holds the helm', async () => {
    const bob = await viewer('bob')
    bob.send({ t: 'open', ticketId: ticket.id, hostId: seats.alice.participantId, prompt: 'look around', cols: 100, rows: 30 })
    const open = await machine.next((m) => m.t === 'open', 'open')
    terminalId = open.terminalId
    assert.equal(open.ticketTitle, 'Search page')
    assert.equal(open.prompt, 'look around')
    assert.equal((await machine.next((m) => m.t === 'helm', 'helm')).claude, false)

    machine.send({ t: 'started', terminalId })
    await stateOf(bob, (t) => t.status === 'running')
    machine.send({ t: 'output', terminalId, data: b64('hello from alice') })
    const output = await bob.next((m) => m.t === 'output', 'output')
    assert.equal(Buffer.from(output.data, 'base64').toString(), 'hello from alice')

    bob.send({ t: 'input', data: b64('ls\r') })
    const input = await machine.next((m) => m.t === 'input', 'input')
    assert.equal(Buffer.from(input.data, 'base64').toString(), 'ls\r')
    await bob.close()
  })

  it('shows a late board what came before, and lets it watch but not type', async () => {
    const carol = await viewer('carol')
    carol.send({ t: 'attach', terminalId })
    await stateOf(carol)
    const replay = await carol.next((m) => m.t === 'replay', 'replay')
    assert.equal(Buffer.from(replay.data, 'base64').toString(), 'hello from alice')

    carol.send({ t: 'input', data: b64('rm -rf /\r') })
    assert.match((await error(carol)).message, /bob has the helm/)
    carol.send({ t: 'helm', to: 'me' })
    assert.match((await error(carol)).message, /Only people in this ticket/)
    carol.send({ t: 'kill' })
    assert.match((await error(carol)).message, /Only people in this ticket/)
    await carol.close()
  })

  it('hands the helm between people and to Claude, and logs each change', async () => {
    const alice = await viewer('alice')
    alice.send({ t: 'attach', terminalId })
    await stateOf(alice)
    alice.send({ t: 'helm', to: 'me' })
    await stateOf(alice, (t) => t.driver === seats.alice.participantId)

    const bob = await viewer('bob')
    bob.send({ t: 'attach', terminalId })
    await stateOf(bob)
    bob.send({ t: 'input', data: b64('x') })
    assert.match((await error(bob)).message, /alice has the helm/)

    bob.send({ t: 'helm', to: 'claude' })
    await stateOf(bob, (t) => t.driver === null)
    assert.equal((await machine.next((m) => m.t === 'helm' && m.claude, 'helm to claude')).claude, true)
    bob.send({ t: 'input', data: b64('x') })
    assert.match((await error(bob)).message, /Claude has the helm/)

    const drivers = audit('terminal.helm').map((e) => e.body.driver)
    assert.deepEqual(drivers, [seats.bob.participantId, seats.alice.participantId, null])
    assert.equal(audit('terminal.opened').length, 1)
    await alice.close()
    await bob.close()
  })

  it('runs one terminal per checkout', async () => {
    const bob = await viewer('bob')
    bob.send({ t: 'open', ticketId: ticket.id, hostId: seats.alice.participantId, cols: 80, rows: 24 })
    assert.match((await error(bob)).message, /already running a terminal/)
    await bob.close()
  })

  it('stops on request and says how it ended', async () => {
    const bob = await viewer('bob')
    bob.send({ t: 'attach', terminalId })
    await stateOf(bob)
    bob.send({ t: 'kill' })
    await machine.next((m) => m.t === 'kill', 'kill')
    machine.send({ t: 'exit', terminalId, code: 0, reason: null })
    const ended = await stateOf(bob, (t) => t.status === 'exited')
    assert.equal(ended.terminal.exitCode, 0)
    assert.equal(audit('terminal.closed').length, 1)
    await bob.close()
  })

  it('marks a terminal ended when its machine goes away', async () => {
    const bob = await viewer('bob')
    bob.send({ t: 'open', ticketId: ticket.id, hostId: seats.alice.participantId, drive: 'claude', cols: 80, rows: 24 })
    const open = await machine.next((m) => m.t === 'open', 'open')
    machine.send({ t: 'started', terminalId: open.terminalId })
    await stateOf(bob, (t) => t.status === 'running' && t.driver === null)
    await machine.close()
    const ended = await stateOf(bob, (t) => t.status === 'exited')
    assert.match(ended.terminal.reason, /went away/)
    assert.deepEqual(app.service.snapshotOf(sessionId).terminalHosts, [])
    await bob.close()
  })

  it('refuses a host that is not a checkout', async () => {
    const conn = await socket(`${base}/term?role=host`)
    conn.send({ t: 'hello', token: 'forged', access: 'members' })
    assert.equal((await conn.next((m) => m.t === 'refused', 'refused')).t, 'refused')
    await conn.close()
  })

  it('refuses a board without a ticket', async () => {
    const conn = await socket(`${base}/term`)
    assert.match((await error(conn)).message, /fresh ticket/)
    await conn.close()
  })

  it('still serves the main socket beside it', async () => {
    const ticketFor = issueWsTicket(app.auth, 'bob', { sessionId, participantId: seats.bob.participantId })
    const main = await socket(`${base}/ws?ticket=${encodeURIComponent(ticketFor)}`)
    main.send({ kind: 'ping', ts: 1 })
    assert.equal((await main.next((m) => m.kind === 'pong', 'pong')).ts, 1)
    await main.close()
  })
})
