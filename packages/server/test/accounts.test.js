import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { createApp } from '../dist/index.js'
import { SESSION_COOKIE, issueCookieValue, upsertUser } from '../dist/auth.js'

/**
 * An oauth server that a plugin signs in to, with a policy deciding who sees
 * and joins what -- the shape a shared, hosted deployment runs in.
 */
const SECRET = 'accounts-test-secret'
const REPO = { owner: 'acme', name: 'web', baseBranch: 'main', remoteUrl: 'git@github.com:acme/web.git' }

let app
let base
const owners = new Map()
const joinRefusals = new Set()

before(async () => {
  app = createApp({
    dbPath: ':memory:',
    webRoot: null,
    auth: { mode: 'oauth', secret: SECRET, githubClientId: 'x', githubClientSecret: 'y', publicUrl: 'http://example.test' },
    policy: {
      mayCreateSession: (user) => (user.githubLogin === 'broke' ? 'Your plan allows one session.' : null),
      sessionCreated: (user, sessionId) => owners.set(sessionId, user.id),
      maySeeSession: (user, sessionId) => owners.get(sessionId) === user.id || user.githubLogin === 'teammate',
      mayJoinSession: (user) => (joinRefusals.has(user.githubLogin) ? 'No seats left.' : null),
    },
    extend: ({ fastify, userFor }) => {
      fastify.get('/api/extra/whoami', async (request) => ({ login: userFor(request)?.githubLogin ?? null }))
    },
  })
  base = await app.listen(0)
})

after(async () => {
  await app.close()
})

function person(login) {
  const user = upsertUser(app.store, { githubId: `gh:${login}`, githubLogin: login, displayName: login, avatarUrl: null })
  return { user, cookie: `${SESSION_COOKIE}=${encodeURIComponent(issueCookieValue(app.auth, user.id))}` }
}

async function call(method, path, body, headers = {}) {
  const response = await fetch(new URL(path, base), {
    method,
    redirect: 'manual',
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  let parsed = text
  try {
    parsed = JSON.parse(text)
  } catch {}
  return { status: response.status, body: parsed, headers: response.headers }
}

/** The whole plugin sign-in: start, approve in a signed-in browser, collect. */
async function signIn(login) {
  const { cookie } = person(login)
  const started = await call('POST', '/api/device', { label: `${login}'s laptop` })
  assert.equal(started.status, 200)
  assert.match(started.body.userCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
  assert.equal(started.body.verifyUrl, `http://example.test/auth/device?code=${started.body.userCode}`)

  const pending = await call('POST', '/api/device/token', { deviceCode: started.body.deviceCode })
  assert.equal(pending.status, 202)

  const page = await call('GET', `/auth/device?code=${started.body.userCode}`, null, { cookie })
  assert.equal(page.status, 200)
  assert.match(page.body, new RegExp(started.body.userCode))

  const approved = await fetch(new URL('/auth/device', base), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ code: started.body.userCode }).toString(),
  })
  assert.equal(approved.status, 200)
  assert.match(await approved.text(), /Signed in/)

  const collected = await call('POST', '/api/device/token', { deviceCode: started.body.deviceCode })
  assert.equal(collected.status, 200)
  assert.match(collected.body.token, /^ssa_/)
  assert.equal(collected.body.user.githubLogin, login)
  return collected.body.token
}

const bearer = (token) => ({ authorization: `Bearer ${token}` })

describe('plugin sign-in', () => {
  it('hands the token out once', async () => {
    const { cookie } = person('once')
    const started = await call('POST', '/api/device', {})
    await fetch(new URL('/auth/device', base), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: `code=${started.body.userCode}`,
    })
    const first = await call('POST', '/api/device/token', { deviceCode: started.body.deviceCode })
    assert.equal(first.status, 200)
    const second = await call('POST', '/api/device/token', { deviceCode: started.body.deviceCode })
    assert.equal(second.status, 410)
  })

  it('sends a signed-out browser to GitHub and back', async () => {
    const started = await call('POST', '/api/device', {})
    const page = await call('GET', `/auth/device?code=${started.body.userCode}`)
    assert.equal(page.status, 302)
    assert.match(page.headers.get('location'), /^\/auth\/github\?redirect_to=/)
  })

  it('refuses an approval posted from another site', async () => {
    const { cookie } = person('csrf')
    const started = await call('POST', '/api/device', {})
    const response = await fetch(new URL('/auth/device', base), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, origin: 'https://evil.test' },
      body: `code=${started.body.userCode}`,
    })
    assert.equal(response.status, 403)
  })

  it('makes the token a credential, until it is revoked', async () => {
    const token = await signIn('alice')
    const me = await call('GET', '/api/me', null, bearer(token))
    assert.equal(me.body.user.githubLogin, 'alice')
    const extra = await call('GET', '/api/extra/whoami', null, bearer(token))
    assert.equal(extra.body.login, 'alice')

    assert.equal((await call('POST', '/api/account/logout', null, bearer(token))).status, 200)
    const after = await call('GET', '/api/me', null, bearer(token))
    assert.equal(after.body.user, null)
  })
})

describe('sessions under a policy', () => {
  let ownerToken
  let invite

  before(async () => {
    ownerToken = await signIn('owner')
    const created = await call(
      'POST',
      '/api/sessions',
      { slug: 'acme-web', title: 'web', repo: REPO, issueRef: null },
      bearer(ownerToken),
    )
    assert.equal(created.status, 200, JSON.stringify(created.body))
    invite = created.body.invite
    assert.ok(invite, 'an oauth server hands out an invite too')
  })

  it('lets the policy refuse a new session', async () => {
    const token = await signIn('broke')
    const created = await call('POST', '/api/sessions', { slug: 'nope', title: 'nope', repo: REPO, issueRef: null }, bearer(token))
    assert.equal(created.status, 403)
    assert.equal(created.body.message, 'Your plan allows one session.')
  })

  it('joins the owner with an invite and their account token', async () => {
    const joined = await call('POST', '/api/join', { invite, repoPath: '/work/owner' }, bearer(ownerToken))
    assert.equal(joined.status, 200, JSON.stringify(joined.body))
    assert.equal(joined.body.githubLogin, 'owner')
    assert.ok(joined.body.participantToken)
  })

  it('needs an account to use an invite', async () => {
    const joined = await call('POST', '/api/join', { invite, repoPath: '/work/anon' })
    assert.equal(joined.status, 401)
    assert.equal(joined.body.reason, 'sign_in')
  })

  it('hides sessions the policy does not show', async () => {
    const stranger = await signIn('stranger')
    const listed = await call('GET', '/api/sessions', null, bearer(stranger))
    assert.deepEqual(listed.body.sessions, [])
    const read = await call('GET', '/sessions/acme-web/snapshot', null, bearer(stranger))
    assert.equal(read.status, 403)
    const code = await call('POST', '/api/sessions/acme-web/join-token', null, bearer(stranger))
    assert.equal(code.status, 404)

    const mine = await call('GET', '/api/sessions', null, bearer(ownerToken))
    assert.deepEqual(mine.body.sessions.map((s) => s.slug), ['acme-web'])
  })

  it('lets the policy refuse a seat, but never a returning one', async () => {
    const teammate = await signIn('teammate')
    joinRefusals.add('teammate')
    const refused = await call('POST', '/api/join', { invite, repoPath: '/work/teammate' }, bearer(teammate))
    assert.equal(refused.status, 403)
    assert.equal(refused.body.message, 'No seats left.')

    joinRefusals.delete('teammate')
    const joined = await call('POST', '/api/join', { invite, repoPath: '/work/teammate' }, bearer(teammate))
    assert.equal(joined.status, 200)

    joinRefusals.add('teammate')
    const again = await call('POST', '/api/join', { invite, repoPath: '/work/teammate' }, bearer(teammate))
    assert.equal(again.status, 200, 'someone already seated keeps their seat')
    joinRefusals.delete('teammate')
  })
})

describe('GitHub sign-in security', () => {
  it('binds OAuth state to this browser and limits the redirect to local paths', async () => {
    const result = await call('GET', '/auth/github?redirect_to=https%3A%2F%2Fevil.test')
    assert.equal(result.status, 302)
    const state = new URL(result.headers.get('location')).searchParams.get('state')
    assert.match(result.headers.get('set-cookie'), new RegExp(`ss_oauth_state=${state}`))
    assert.match(result.headers.get('set-cookie'), /HttpOnly; SameSite=Lax; Max-Age=600/)
    const foreign = await call('GET', `/auth/github/callback?code=anything&state=${state}`)
    assert.equal(foreign.status, 400)
    assert.match(foreign.body.message, /another browser/)
    assert.equal(app.store.consumeOauthState(state).redirectTo, '/')
  })
  it('expires OAuth states and consumes each valid state once', () => {
    app.store.createOauthState('expired', '/account', Date.now() - 11 * 60 * 1000)
    assert.equal(app.store.consumeOauthState('expired'), null)
    app.store.createOauthState('fresh', '/account', Date.now())
    assert.equal(app.store.consumeOauthState('fresh').redirectTo, '/account')
    assert.equal(app.store.consumeOauthState('fresh'), null)
  })
})
