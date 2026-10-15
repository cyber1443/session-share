import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createApp } from '@session-share/server'
import { SESSION_COOKIE, issueCookieValue, upsertUser } from '../../server/dist/auth.js'

/**
 * Hosting on a server somebody else runs, through the real MCP tools: sign in
 * with a code approved in a browser, open the session there, and have a
 * teammate join it with the invite plus their own account. Nothing starts on
 * this machine, and the server's policy decides who gets a seat.
 */
const MCP = new URL('../dist/mcp.js', import.meta.url).pathname

let scratch
let app
let serverUrl
const clients = []
const fullFor = new Set()

before(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'ss-hosted-'))
  app = createApp({
    dbPath: ':memory:',
    webRoot: null,
    auth: { mode: 'oauth', secret: 'hosted-test', githubClientId: 'x', githubClientSecret: 'y' },
    policy: { mayJoinSession: (user) => (fullFor.has(user.githubLogin) ? 'This team has no seats left.' : null) },
  })
  serverUrl = (await app.listen(0)).replace('[::1]', '127.0.0.1')
  app.auth.publicUrl = serverUrl
})

after(async () => {
  for (const client of clients) await client.close().catch(() => {})
  await app.close()
  rmSync(scratch, { recursive: true, force: true })
})

function repo(name) {
  const dir = join(scratch, name, 'app')
  mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'], {
    cwd: dir,
  })
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/web.git'], { cwd: dir })
  return dir
}

async function claudeCode(repoPath, home) {
  const client = new Client({ name: 'hosted-test', version: '1' })
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [MCP],
      stderr: 'ignore',
      env: {
        ...process.env,
        SESSION_SHARE_REPO: repoPath,
        SESSION_SHARE_HOME: home,
        SESSION_SHARE_NO_OPEN: '1',
        SESSION_SHARE_AUTOPILOT: 'off',
        SESSION_SHARE_MIRROR: 'off',
      },
    }),
  )
  clients.push(client)
  return async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 })
    const body = result.content.map((c) => c.text).join('\n')
    if (result.isError) throw new Error(body)
    return body
  }
}

/** Plays the person in the browser: waits for the code, then approves it as `login`. */
async function approveWhenAsked(home, login) {
  const file = join(home, 'accounts.json')
  for (let i = 0; i < 100; i++) {
    if (existsSync(file)) {
      const pending = Object.values(JSON.parse(readFileSync(file, 'utf8')).pending ?? {})[0]
      if (pending) {
        const user = upsertUser(app.store, { githubId: `gh:${login}`, githubLogin: login, displayName: login, avatarUrl: null })
        const cookie = `${SESSION_COOKIE}=${encodeURIComponent(issueCookieValue(app.auth, user.id))}`
        const response = await fetch(`${serverUrl}/auth/device`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
          body: `code=${pending.userCode}`,
        })
        assert.equal(response.status, 200)
        return
      }
    }
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error('the plugin never asked to be approved')
}

const configOf = (path) => JSON.parse(readFileSync(join(path, '.session-share/session.json'), 'utf8'))

describe('a session on a hosted server', () => {
  it('signs in, hosts there, and lets a signed-in teammate join', async () => {
    const aliceHome = join(scratch, 'alice-home')
    const bobHome = join(scratch, 'bob-home')
    mkdirSync(aliceHome)
    mkdirSync(bobHome)
    const aliceRepo = repo('alice')
    const bobRepo = repo('bob')

    const alice = await claudeCode(aliceRepo, aliceHome)
    const [login] = await Promise.all([alice('ss_login', { serverUrl }), approveWhenAsked(aliceHome, 'alice')])
    assert.match(login, /Signed in to .* as @alice/)

    const hosted = await alice('ss_host')
    assert.match(hosted, /^Hosting "app" on /)
    assert.equal(configOf(aliceRepo).serverUrl, serverUrl)
    assert.equal(configOf(aliceRepo).sessionRef, 'acme-web')
    const invite = hosted.match(/\/ss:join (ssx_\S+)/)[1]

    const bob = await claudeCode(bobRepo, bobHome)
    await assert.rejects(bob('ss_join', { code: invite }), /\/ss:login/)

    await Promise.all([bob('ss_login', { serverUrl }), approveWhenAsked(bobHome, 'bob')])
    fullFor.add('bob')
    await assert.rejects(bob('ss_join', { code: invite }), /no seats left/)
    fullFor.delete('bob')

    const joined = await bob('ss_join', { code: invite })
    assert.match(joined, /Joined "app" as bob/)
    assert.match(joined, /\/board\/\?s=acme-web/)

    const again = await alice('ss_host')
    assert.match(again, /^Resumed "app"/, 'hosting again carries on in the same session')

    const stopped = await alice('ss_stop_host')
    assert.match(stopped, /nothing here to stop/)

    const out = await bob('ss_logout')
    assert.match(out, /Signed @bob out/)
  })
})
