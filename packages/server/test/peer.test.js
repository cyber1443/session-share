import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { createApp, isLoopbackAddress } from '../dist/index.js'
import { devLoginAllowed } from '../dist/auth.js'

const REPO = {
  owner: 'acme',
  name: 'web',
  baseBranch: 'main',
  remoteUrl: 'git@github.com:acme/web.git',
}

let app
let baseUrl

before(async () => {
  app = createApp({
    dbPath: ':memory:',
    webRoot: null,
    auth: { mode: 'peer', secret: 'peer-test-secret' },
  })
  baseUrl = await app.listen(0)
})

after(async () => {
  await app.close()
})

async function post(path, body, headers = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

/**
 * These two decide whether "only this machine" means anything at all. Both were
 * written against the Host header first, which a remote caller controls -- so
 * they are pinned here against the socket address instead.
 */
describe('loopback detection', () => {
  it('accepts real loopback addresses', () => {
    assert.equal(isLoopbackAddress('127.0.0.1'), true)
    assert.equal(isLoopbackAddress('::1'), true)
    assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
    assert.equal(isLoopbackAddress('127.0.0.53'), true)
  })

  it('rejects everything else', () => {
    assert.equal(isLoopbackAddress('192.168.0.36'), false)
    assert.equal(isLoopbackAddress('10.0.0.1'), false)
    assert.equal(isLoopbackAddress('::ffff:192.168.0.36'), false)
    assert.equal(isLoopbackAddress(undefined), false)
    // A hostname is not an address; only the socket is trusted.
    assert.equal(isLoopbackAddress('localhost'), false)
  })

  it('gates dev login on the socket, not on a claim', () => {
    const config = { devLogin: true }
    assert.equal(devLoginAllowed(config, '127.0.0.1'), true)
    assert.equal(devLoginAllowed(config, '192.168.0.36'), false)
    assert.equal(devLoginAllowed({ devLogin: false }, '127.0.0.1'), false)
  })
})

describe('peer sessions', () => {
  let invite

  it('creates a session and returns the invite with it', async () => {
    const created = await post('/api/sessions', {
      slug: 'peer-session',
      title: 'Peer session',
      repo: REPO,
      issueRef: null,
    })
    assert.equal(created.status, 200)
    assert.ok(created.body.invite, 'a peer session is useless without its invite')
    invite = created.body.invite
  })

  it('lets anyone holding the invite join, with no login', async () => {
    const joined = await post('/api/peer/join', {
      invite,
      githubLogin: 'alice',
      displayName: 'Alice',
      repoPath: '/tmp/peer-alice',
    })
    assert.equal(joined.status, 200)
    assert.ok(joined.body.participantToken)
    assert.equal(joined.body.sessionRef, 'peer-session')
  })

  it('is reusable, unlike a hosted join code', async () => {
    const first = await post('/api/peer/join', {
      invite,
      githubLogin: 'bob',
      displayName: 'Bob',
      repoPath: '/tmp/peer-bob',
    })
    const second = await post('/api/peer/join', {
      invite,
      githubLogin: 'bob',
      displayName: 'Bob',
      repoPath: '/tmp/peer-bob',
    })
    assert.equal(second.status, 200)
    assert.equal(
      second.body.participantId,
      first.body.participantId,
      'the same person rejoining is the same participant',
    )
  })

  it('seats a browser with no checkout at all', async () => {
    const joined = await post('/api/peer/join', {
      invite,
      githubLogin: 'cara',
      displayName: 'Cara',
      repoPath: null,
    })
    assert.equal(joined.status, 200)
  })

  it('refuses a forged invite', async () => {
    const joined = await post('/api/peer/join', {
      invite: 'not.a.real.invite',
      githubLogin: 'mallory',
      displayName: 'Mallory',
      repoPath: '/tmp/peer-mallory',
    })
    assert.equal(joined.status, 401)
  })

  /**
   * The commonest cause of a rejected invite is not a bad token but the wrong
   * server -- the guest dialled a loopback address and reached their own. The
   * refusal has to name that, because from inside it is indistinguishable.
   */
  it('names itself when it refuses, so a guest can tell it is the wrong server', async () => {
    const health = await (await fetch(new URL('/healthz', baseUrl))).json()
    assert.match(health.serverId, /^[0-9a-f]{16}$/)
    assert.equal(health.mode, 'peer')

    const other = createApp({
      dbPath: ':memory:',
      webRoot: null,
      auth: { mode: 'peer', secret: 'a-different-machine' },
    })
    const otherUrl = await other.listen(0)
    const otherHealth = await (await fetch(new URL('/healthz', otherUrl), {})).json()
    assert.notEqual(otherHealth.serverId, health.serverId, 'two secrets, two identities')

    // A perfectly good invite, presented to the machine that did not mint it.
    const response = await fetch(new URL('/api/peer/join', otherUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        invite,
        githubLogin: 'guest',
        displayName: 'Guest',
        repoPath: null,
      }),
    })
    const payload = await response.json()
    assert.equal(response.status, 401)
    assert.equal(payload.serverId, otherHealth.serverId)
    assert.match(payload.message, /pointing at your own machine/)
    await other.close()
  })

  it('still refuses two people in one working tree', async () => {
    const joined = await post('/api/peer/join', {
      invite,
      githubLogin: 'dave',
      displayName: 'Dave',
      repoPath: '/tmp/peer-alice',
    })
    assert.equal(joined.status, 409)
    assert.match(joined.body.message, /separate clone or git worktree/)
  })

  it('scopes a listing to the token that asked', async () => {
    const joined = await post('/api/peer/join', {
      invite,
      githubLogin: 'erin',
      displayName: 'Erin',
      repoPath: null,
    })
    const listed = await fetch(new URL('/api/sessions', baseUrl), {
      headers: { authorization: `Bearer ${joined.body.participantToken}` },
    })
    const payload = await listed.json()
    assert.equal(payload.sessions.length, 1)
    assert.equal(payload.sessions[0].slug, 'peer-session')
  })

  it('refuses to list anything without a token', async () => {
    const listed = await fetch(new URL('/api/sessions', baseUrl))
    assert.equal(listed.status, 401)
  })

  it('reports peer mode so the board knows not to ask for a login', async () => {
    const me = await (await fetch(new URL('/api/me', baseUrl))).json()
    assert.equal(me.mode, 'peer')
    assert.equal(me.user, null)
  })
})

describe('oauth mode rejects the peer shortcut', () => {
  it('404s /api/peer/join when identity is verified', async () => {
    const oauthApp = createApp({
      dbPath: ':memory:',
      webRoot: null,
      auth: { mode: 'oauth', secret: 's', githubClientId: 'x', githubClientSecret: 'y' },
    })
    const url = await oauthApp.listen(0)
    const response = await fetch(new URL('/api/peer/join', url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ invite: 'x', githubLogin: 'a', displayName: 'A', repoPath: null }),
    })
    assert.equal(response.status, 404)
    await oauthApp.close()
  })
})
