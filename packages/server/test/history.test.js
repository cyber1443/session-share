import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { GitHubReader, createApp } from '../dist/index.js'
import { HOST_HEADER, hostCredential } from '../dist/auth.js'

/**
 * The project's long view: what happened, what each person's Claude spent, and
 * what GitHub says about the repository -- all read through a seat's own token.
 */
const SECRET = 'history-test-secret'
const REPO = { owner: 'acme', name: 'web', baseBranch: 'main', remoteUrl: 'git@github.com:acme/web.git' }

const githubCalls = []
const fakeFetch = async (url, init) => {
  githubCalls.push({ url: String(url), auth: init.headers.authorization })
  const body = String(url).includes('/pulls')
    ? [
        {
          number: 7,
          title: 'Tags on todos',
          html_url: 'https://github.com/acme/web/pull/7',
          draft: false,
          updated_at: '2026-10-09T10:00:00Z',
          user: { login: 'ann' },
          head: { ref: 'ss/web/contract' },
          base: { ref: 'main' },
        },
      ]
    : {
        workflow_runs: [
          {
            id: 1,
            name: 'CI',
            display_title: 'Tags on todos',
            head_branch: 'ss/web/contract',
            event: 'pull_request',
            status: 'completed',
            conclusion: 'failure',
            html_url: 'https://github.com/acme/web/actions/runs/1',
            created_at: '2026-10-09T10:01:00Z',
          },
        ],
      }
  return new Response(JSON.stringify(body), { status: 200 })
}

let app
let base

before(async () => {
  app = createApp({
    dbPath: ':memory:',
    webRoot: null,
    auth: { mode: 'peer', secret: SECRET },
    github: new GitHubReader(fakeFetch, async () => 'server-token'),
  })
  base = await app.listen(0)
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

const bearer = (token) => ({ authorization: `Bearer ${token}` })

async function seats(slug) {
  const created = await call(
    'POST',
    '/api/sessions',
    { slug, title: slug, repo: REPO, issueRef: null },
    { [HOST_HEADER]: hostCredential(app.auth) },
  )
  const join = (login, repoPath, machineId) =>
    call('POST', '/api/peer/join', {
      invite: created.body.invite,
      githubLogin: login,
      displayName: login,
      repoPath,
      machineId,
    }).then((r) => r.body)
  return { join }
}

const command = (token, sessionRef, cmd) =>
  call('POST', '/api/commands', { sessionRef, command: cmd }, bearer(token))

describe('project history', () => {
  it('lists what happened and totals each person\'s usage across all their seats', async () => {
    const { join } = await seats('hist')
    const annA = await join('ann', '/tmp/ann/a', 'm1')
    const annB = await join('Ann', '/tmp/ann/b', 'm1')
    const ben = await join('ben', '/tmp/ben', 'm2')

    await command(annA.participantToken, 'hist', { type: 'ticket.create', title: 'Tags', body: '' })
    const usage = (tokens) => ({
      type: 'usage.report',
      inputTokens: tokens,
      outputTokens: tokens * 2,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      turns: 1,
    })
    await command(annA.participantToken, 'hist', usage(100))
    await command(annB.participantToken, 'hist', usage(50))
    await command(ben.participantToken, 'hist', usage(10))

    const read = await call('GET', '/sessions/hist/history', null, bearer(ben.participantToken))
    assert.equal(read.status, 200)
    const created = read.body.entries.find((e) => e.type === 'ticket.created')
    assert.equal(created.title, 'Tags')
    assert.ok(!read.body.entries.some((e) => e.type === 'chat.message'), 'the room is not the history')

    const byLogin = Object.fromEntries(read.body.usage.map((u) => [u.login, u]))
    assert.equal(byLogin.ann.inputTokens, 150, 'two checkouts of one person are one person to pay')
    assert.equal(byLogin.ann.outputTokens, 300)
    assert.equal(byLogin.ben.inputTokens, 10)

    // Read again: only what was appended since is folded in, and nothing doubles.
    await command(ben.participantToken, 'hist', usage(5))
    const again = await call('GET', '/sessions/hist/history', null, bearer(ben.participantToken))
    const benNow = again.body.usage.find((u) => u.login === 'ben')
    assert.equal(benNow.inputTokens, 15)
    assert.equal(again.body.usage.find((u) => u.login === 'ann').inputTokens, 150)
  })

  it('is closed to anyone without a seat in the session', async () => {
    const { join } = await seats('hist-closed')
    await join('ann', '/tmp/ann/c', 'm1')
    const { join: joinOther } = await seats('hist-other')
    const stranger = await joinOther('eve', '/tmp/eve', 'm3')
    assert.equal((await call('GET', '/sessions/hist-closed/history')).status, 401)
    assert.equal(
      (await call('GET', '/sessions/hist-closed/history', null, bearer(stranger.participantToken))).status,
      403,
    )
  })
})

describe('github on the board', () => {
  it('reads open pull requests and Actions runs with the server\'s token, and caches them', async () => {
    const { join } = await seats('gh')
    const ann = await join('ann', '/tmp/ann/gh', 'm1')
    githubCalls.length = 0

    const read = await call('GET', '/sessions/gh/github', null, bearer(ann.participantToken))
    assert.equal(read.status, 200)
    assert.equal(read.body.repo, 'acme/web')
    assert.equal(read.body.pulls[0].number, 7)
    assert.equal(read.body.runs[0].conclusion, 'failure')
    assert.equal(read.body.error, null)
    assert.ok(githubCalls.every((c) => c.auth === 'Bearer server-token'))
    assert.ok(githubCalls.some((c) => c.url.includes('/repos/acme/web/actions/runs')))

    const calls = githubCalls.length
    await call('GET', '/sessions/gh/github', null, bearer(ann.participantToken))
    assert.equal(githubCalls.length, calls, 'a board polling does not spend GitHub\'s rate limit')
  })

  it('says why when GitHub refuses', async () => {
    const reader = new GitHubReader(async () => new Response('{}', { status: 404 }), async () => null)
    const status = await reader.status(REPO)
    assert.match(status.error, /no token/)
    assert.deepEqual(status.pulls, [])
  })
})

describe('restoring a session from its mirror', () => {
  it('rebuilds the same session on a fresh server, and hands people their own seats back', async () => {
    const { join } = await seats('mirror-src')
    const ann = await join('ann', '/tmp/ann/m', 'm1')
    await command(ann.participantToken, 'mirror-src', { type: 'ticket.create', title: 'Carry me over', body: '' })
    const exported = await call('GET', '/sessions/mirror-src/events?from=0&limit=5000', null, bearer(ann.participantToken))
    assert.equal(exported.status, 200)
    const sessionId = exported.body.events[0].sessionId

    const fresh = createApp({ dbPath: ':memory:', webRoot: null, auth: { mode: 'peer', secret: 'another-secret' } })
    const freshBase = await fresh.listen(0)
    try {
      const post = (path, body, headers = {}) =>
        fetch(new URL(path, freshBase), {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(body),
        }).then(async (r) => ({ status: r.status, body: await r.json() }))
      const payload = { sessionId, slug: 'mirror-src', events: exported.body.events }

      assert.equal((await post('/api/sessions/import', payload)).status, 403, 'only the host may write history')
      const host = { [HOST_HEADER]: hostCredential(fresh.auth) }
      const imported = await post('/api/sessions/import', payload, host)
      assert.equal(imported.status, 200, JSON.stringify(imported.body))
      assert.equal(imported.body.added, exported.body.events.length)

      const again = await post('/api/sessions/import', payload, host)
      assert.equal(again.body.added, 0, 'importing what is already there changes nothing')

      const tampered = structuredClone(exported.body.events)
      tampered[1].ts += 1
      tampered[1].body = { ...tampered[1].body, participant: { ...tampered[1].body.participant, displayName: 'Mallory' } }
      assert.equal((await post('/api/sessions/import', { ...payload, events: tampered }, host)).status, 409)

      const snapshot = fresh.service.snapshotOf(sessionId)
      assert.equal(snapshot.session.id, sessionId, 'the same id, so everything that names it still does')
      assert.ok(snapshot.tickets.some((t) => t.title === 'Carry me over'))

      const rejoined = await post('/api/peer/join', {
        invite: imported.body.invite,
        githubLogin: 'ann',
        displayName: 'ann',
        repoPath: '/tmp/ann/m',
        machineId: 'm1',
      })
      assert.equal(rejoined.status, 200, JSON.stringify(rejoined.body))
      assert.equal(rejoined.body.participantId, ann.participantId, 'ann gets their own seat back, not a new one')
    } finally {
      await fresh.close()
    }
  })
})
