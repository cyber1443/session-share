import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

/**
 * Hosting through the real MCP tool, against a real daemon. The slug used to
 * be the folder name, so two unrelated checkouts that were both called `app`
 * landed in one session: the second host quietly "resumed" the first one's,
 * with its chat, its tickets and its people.
 */
const PORT = Number(process.env.SESSION_SHARE_HOST_TEST_PORT ?? 4391)
const MCP = new URL('../dist/mcp.js', import.meta.url).pathname

let scratch
let home
const clients = []

before(() => {
  scratch = mkdtempSync(join(tmpdir(), 'ss-host-'))
  home = join(scratch, 'home')
  mkdirSync(home)
})

after(async () => {
  for (const client of clients) await client.close().catch(() => {})
  try {
    const health = await (await fetch(`http://127.0.0.1:${PORT}/healthz`)).json()
    if (health.pid) process.kill(health.pid)
  } catch {}
  rmSync(scratch, { recursive: true, force: true })
})

function repo(parent) {
  const dir = join(scratch, parent, 'app')
  mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'], {
    cwd: dir,
  })
  return dir
}

async function claudeCode(repoPath) {
  const client = new Client({ name: 'host-test', version: '1' })
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [MCP],
      stderr: 'ignore',
      env: {
        ...process.env,
        SESSION_SHARE_REPO: repoPath,
        SESSION_SHARE_HOME: home,
        SESSION_SHARE_PORT: String(PORT),
        SESSION_SHARE_LOGIN: 'alice',
        SESSION_SHARE_NO_OPEN: '1',
      },
    }),
  )
  clients.push(client)
  return async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args })
    const body = result.content.map((c) => c.text).join('\n')
    if (result.isError) throw new Error(body)
    return body
  }
}

const sessionOf = (path) => JSON.parse(readFileSync(join(path, '.session-share/session.json'), 'utf8')).sessionRef

describe('hosting two repositories with the same folder name', () => {
  it('gives each its own session, and resumes only its own', async () => {
    const work = repo('work')
    const personal = repo('personal')

    const first = await (await claudeCode(work))('ss_host', { expose: 'loopback' })
    assert.match(first, /^Hosting/)
    const workSession = sessionOf(work)
    const second = await (await claudeCode(personal))('ss_host', { expose: 'loopback' })
    assert.match(second, /^Hosting/, 'an unrelated repo must not resume a namesake')
    assert.notEqual(sessionOf(work), sessionOf(personal))

    const again = await (await claudeCode(work))('ss_host', { expose: 'loopback' })
    assert.match(again, /^Resumed/, 'hosting the same repo again still resumes it')
    assert.equal(sessionOf(work), workSession)
  })
})

/**
 * Before 0.10 a session was named after the bare folder. Re-hosting is the
 * documented way to resume, so after an upgrade it has to land back in that
 * session -- not open an empty one beside it while every guest stays put.
 */
describe('re-hosting a session from before the slug changed', () => {
  it('resumes it by its old name', async () => {
    const legacy = repo('legacy')
    const host = await claudeCode(legacy)
    assert.match(await host('ss_host', { expose: 'loopback', title: 'app' }), /^Hosting|^Resumed/)
    const original = sessionOf(legacy)
    rmSync(join(legacy, '.session-share'), { recursive: true, force: true })

    const again = await (await claudeCode(legacy))('ss_host', { expose: 'loopback' })
    assert.match(again, /^Resumed/)
    assert.equal(sessionOf(legacy), original)
  })
})
