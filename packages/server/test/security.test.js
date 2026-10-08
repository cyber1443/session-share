import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { createApp } from '../dist/index.js'
import { HOST_HEADER, devLoginAllowed, encodeToken, hostCredential } from '../dist/auth.js'
import { TestClient, expectError, settle, ticketFor, useApp } from './client.js'

/**
 * Who may do what, from the outside. Every case here was reachable with nothing
 * but curl or a bare websocket before it was pinned down: joining as someone
 * else, reading one session with another's token, minting an invite by guessing
 * a slug, and a tunnel turning every guest into "the host".
 */
const SECRET = 'security-test-secret'
const REPO = { owner: 'acme', name: 'web', baseBranch: 'main', remoteUrl: 'git@github.com:acme/web.git' }

let app
let base
let wsUrl

before(async () => {
  app = createApp({ dbPath: ':memory:', webRoot: null, auth: { mode: 'peer', secret: SECRET } })
  useApp(app)
  base = await app.listen(0)
  wsUrl = `${base.replace('http://', 'ws://')}/ws`
})

after(async () => {
  await app.close()
})

async function call(method, path, body, headers = {}) {
  const response = await fetch(new URL(path, base), {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: response.status, body: await response.json() }
}

const hostHeaders = () => ({ [HOST_HEADER]: hostCredential(app.auth) })
const bearer = (token) => ({ authorization: `Bearer ${token}` })

async function host(slug) {
  const created = await call('POST', '/api/sessions', { slug, title: slug, repo: REPO, issueRef: null }, hostHeaders())
  assert.equal(created.status, 200, JSON.stringify(created.body))
  return created.body.invite
}

async function peerJoin(invite, login, repoPath, machineId = null) {
  return call('POST', '/api/peer/join', { invite, githubLogin: login, displayName: login, repoPath, machineId })
}

describe('a socket without a ticket', () => {
  it('cannot join a session by claiming a name', async () => {
    await host('ws-anon')
    const anon = await new TestClient(wsUrl).connect()
    const error = await expectError(
      anon.raw({
        type: 'session.join',
        sessionRef: 'ws-anon',
        githubLogin: 'alice',
        displayName: 'Alice',
        repoPath: null,
        fromSeq: null,
      }),
      'unauthorized',
    )
    assert.match(error.message, /ticket/)
    await expectError(
      anon.raw({ type: 'chat.post', body: 'hi from nobody', taskRef: null, asAgent: false, directive: true }),
      'unauthorized',
    )
    await anon.close()
  })

  it('takes the name from the ticket, never from the command', async () => {
    await host('ws-name')
    const socket = await new TestClient(wsUrl).connect(ticketFor('mallory'))
    const joined = await socket.raw({
      type: 'session.join',
      sessionRef: 'ws-name',
      githubLogin: 'alice',
      displayName: 'Alice',
      repoPath: null,
      fromSeq: null,
    })
    const seat = joined.snapshot.participants.find((p) => p.id === joined.participantId)
    assert.equal(seat.githubLogin, 'mallory')
    await socket.close()
  })

  it('cannot open a session, even when authenticated', async () => {
    const socket = await new TestClient(wsUrl).connect(ticketFor('alice'))
    await expectError(
      socket.raw({ type: 'session.create', slug: 'ws-made', title: 't', repo: REPO, issueRef: null }),
      'forbidden',
    )
    await socket.close()
  })
})

describe('a participant token', () => {
  it('is for one session and no other', async () => {
    const inviteA = await host('token-a')
    await host('token-b')
    const alice = (await peerJoin(inviteA, 'alice', '/tmp/token-a')).body

    const envelope = await call(
      'POST',
      '/api/commands',
      { sessionRef: 'token-b', command: { type: 'chat.read' } },
      bearer(alice.participantToken),
    )
    assert.equal(envelope.status, 403)

    const join = await call(
      'POST',
      '/api/commands',
      {
        command: {
          type: 'session.join',
          sessionRef: 'token-b',
          githubLogin: null,
          displayName: null,
          repoPath: '/tmp/token-a',
          fromSeq: null,
        },
      },
      bearer(alice.participantToken),
    )
    assert.equal(join.status, 403, 'a join naming another session is refused too')

    const own = await call('POST', '/api/commands', { command: { type: 'chat.read' } }, bearer(alice.participantToken))
    assert.equal(own.status, 200)
  })

  it('opens a socket that can only join its own session, in its own seat', async () => {
    const invite = await host('ticket-a')
    await host('ticket-b')
    const alice = (await peerJoin(invite, 'alice', '/tmp/ticket-a')).body
    const { body } = await call('GET', '/api/ws-ticket', null, bearer(alice.participantToken))

    const socket = await new TestClient(wsUrl).connect(body.ticket)
    await expectError(
      socket.raw({ type: 'session.join', sessionRef: 'ticket-b', repoPath: null, fromSeq: null }),
      'forbidden',
    )
    const joined = await socket.raw({ type: 'session.join', sessionRef: 'ticket-a', repoPath: null, fromSeq: null })
    assert.equal(joined.participantId, alice.participantId)
    await socket.close()
  })

  it('cannot open sessions through the command endpoint', async () => {
    const invite = await host('cmd-create')
    const alice = (await peerJoin(invite, 'alice', '/tmp/cmd-create')).body
    const made = await call(
      'POST',
      '/api/commands',
      { command: { type: 'session.create', slug: 'sneaky', title: 't', repo: REPO, issueRef: null } },
      bearer(alice.participantToken),
    )
    assert.equal(made.status, 403)
  })
})

describe('minting invites', () => {
  it('refuses anyone who is neither in the session nor its host', async () => {
    await host('mint')
    const anonymous = await call('POST', '/api/sessions/mint/invite')
    assert.equal(anonymous.status, 403)
    assert.equal(anonymous.body.invite, undefined)
  })

  it('lets a seat in that session pass it on, but not a seat elsewhere', async () => {
    const invite = await host('mint-own')
    await host('mint-other')
    const alice = (await peerJoin(invite, 'alice', '/tmp/mint-own')).body
    assert.equal((await call('POST', '/api/sessions/mint-own/invite', null, bearer(alice.participantToken))).status, 200)
    assert.equal((await call('POST', '/api/sessions/mint-other/invite', null, bearer(alice.participantToken))).status, 403)
  })

  it('lets the host mint, and says which repository the session is for', async () => {
    await host('mint-host')
    const minted = await call('POST', '/api/sessions/mint-host/invite', null, hostHeaders())
    assert.equal(minted.status, 200)
    assert.deepEqual(minted.body.repo, REPO)
  })
})

/**
 * cloudflared, ngrok and friends connect to the server from 127.0.0.1, so a
 * check on the socket address waved every guest behind a tunnel through as the
 * host. The test client here is on loopback too -- which is the point.
 */
describe('being the host', () => {
  it('is a credential, not an address', async () => {
    const fromLoopback = await call('POST', '/api/sessions', { slug: 'tunnelled', title: 't', repo: REPO, issueRef: null })
    assert.equal(fromLoopback.status, 403)

    const forged = await call(
      'POST',
      '/api/sessions',
      { slug: 'tunnelled', title: 't', repo: REPO, issueRef: null },
      { [HOST_HEADER]: 'guess' },
    )
    assert.equal(forged.status, 403)

    assert.equal((await host('tunnelled')).length > 0, true)
  })

  it('refuses dev login through anything that forwarded the request', () => {
    const config = { devLogin: true }
    assert.equal(devLoginAllowed(config, '127.0.0.1', {}), true)
    assert.equal(devLoginAllowed(config, '127.0.0.1', { 'x-forwarded-for': '203.0.113.9' }), false)
    assert.equal(devLoginAllowed(config, '127.0.0.1', { 'cf-connecting-ip': '203.0.113.9' }), false)
    assert.equal(devLoginAllowed(config, '::1', { forwarded: 'for=203.0.113.9' }), false)
  })
})

describe('presence', () => {
  it('survives the board tab closing, and is renewed by HTTP', async () => {
    const invite = await host('presence-tab')
    const bob = (await peerJoin(invite, 'bob', '/tmp/presence-bob')).body
    const { body } = await call('GET', '/api/ws-ticket', null, bearer(bob.participantToken))

    const board = await new TestClient(wsUrl).connect(body.ticket)
    await board.raw({ type: 'session.join', sessionRef: 'presence-tab', repoPath: null, fromSeq: null })
    await board.close()
    await settle()

    const sessionId = app.store.findSessionIdByRef('presence-tab')
    // Long silent -- then the agent speaks over HTTP, which is all it ever does.
    app.service.lastSeen.set(bob.participantId, Date.now() - 60 * 60 * 1000)
    const before = app.service.snapshotOf(sessionId).participants.find((p) => p.id === bob.participantId)
    assert.equal(before.connected, false)

    const read = await call('POST', '/api/commands', { command: { type: 'chat.read' } }, bearer(bob.participantToken))
    assert.equal(read.status, 200)
    const now = app.service.snapshotOf(sessionId).participants.find((p) => p.id === bob.participantId)
    assert.equal(now.connected, true, 'any authenticated command is being here')
  })
})

/**
 * Leases belong to participants. When a person in two clones was one
 * participant, either clone could edit what the other had leased, and the gate
 * between them meant nothing.
 */
describe('seats', () => {
  it('gives each checkout of one person its own seat', async () => {
    const invite = await host('seats-two')
    const one = (await peerJoin(invite, 'dave', '/w/clone1', 'm1')).body
    const two = (await peerJoin(invite, 'dave', '/w/clone2', 'm1')).body
    assert.notEqual(one.participantId, two.participantId)

    const again = (await peerJoin(invite, 'dave', '/w/clone1', 'm1')).body
    assert.equal(again.participantId, one.participantId, 'the same checkout is the same seat')
  })

  it('seats a board in a seat the person already has', async () => {
    const invite = await host('seats-board')
    const checkout = (await peerJoin(invite, 'erin', '/w/erin', 'm1')).body
    const board = (await peerJoin(invite, 'erin', null)).body
    assert.equal(board.participantId, checkout.participantId)
  })

  it('treats one path on two machines as two checkouts', async () => {
    const invite = await host('seats-machines')
    const ann = await peerJoin(invite, 'ann', '/workspaces/app', 'laptop-a')
    const ben = await peerJoin(invite, 'ben', '/workspaces/app', 'laptop-b')
    assert.equal(ann.status, 200)
    assert.equal(ben.status, 200, 'different machines cannot share a working tree')

    const cat = await peerJoin(invite, 'cat', '/workspaces/app', 'laptop-a')
    assert.equal(cat.status, 409, 'the same machine and path still can')
  })

  it('does not merge two people whose handles differ only in case', async () => {
    const invite = await host('seats-case')
    const lower = (await peerJoin(invite, 'sam-lee', '/hostA/repo', 'a')).body
    const upper = (await peerJoin(invite, 'Sam-Lee', '/hostB/repo', 'b')).body
    assert.notEqual(lower.participantId, upper.participantId)

    const meLower = await call('GET', '/api/me', null, bearer(lower.participantToken))
    const meUpper = await call('GET', '/api/me', null, bearer(upper.participantToken))
    assert.notEqual(meLower.body.user.id, meUpper.body.user.id)
    assert.equal(meUpper.body.user.participantId, upper.participantId)
  })
})

describe('a refused invite', () => {
  it('says when it has expired, rather than blaming the server', async () => {
    const invite = await host('expired')
    const [body] = invite.split('.')
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    const stale = encodeToken(SECRET, { ...claims, exp: Date.now() - 24 * 60 * 60 * 1000 })

    const joined = await peerJoin(stale, 'erin', null)
    assert.equal(joined.status, 401)
    assert.equal(joined.body.reason, 'expired')
    assert.match(joined.body.message, /expired/)
    assert.doesNotMatch(joined.body.message, /your own machine/)
  })

  it('still names the wrong server when the signature is not ours', async () => {
    const invite = await host('foreign')
    const [body] = invite.split('.')
    const foreign = encodeToken('another-machine', JSON.parse(Buffer.from(body, 'base64url').toString('utf8')))
    const joined = await peerJoin(foreign, 'erin', null)
    assert.equal(joined.body.reason, 'signature')
    assert.match(joined.body.message, /not signed by this server/)
  })

  it('calls a mangled one damaged', async () => {
    const joined = await peerJoin('not-even-close', 'erin', null)
    assert.equal(joined.body.reason, 'malformed')
  })
})
