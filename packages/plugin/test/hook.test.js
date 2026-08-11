import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { createApp } from '@session-share/server'
import { extractPaths, toRepoRelative } from '../dist/hook.js'
import { writeConfig, readConfig } from '../dist/config.js'
import { pair, runCommand } from '../dist/client.js'

const HOOK = new URL('../dist/hook.js', import.meta.url).pathname

const REPO = {
  owner: 'acme',
  name: 'web',
  baseBranch: 'main',
  remoteUrl: 'git@github.com:acme/web.git',
}

const contract = {
  summary: 'Theme seam',
  files: [{ path: 'src/lib/theme-types.ts', purpose: 'Theme union', contents: 'export type Theme = "light"\n' }],
}

const tasks = [
  {
    id: 'theme-toggle',
    title: 'Toggle',
    intent: 'toggle component',
    ownedPaths: ['src/components/theme-toggle/**'],
    dependsOn: [],
    assumes: [],
    acceptance: { testCommand: 'npm test -- toggle', testFiles: ['src/components/theme-toggle/t.test.tsx'], manualChecks: [] },
    estimateMinutes: 45,
  },
  {
    id: 'theme-persist',
    title: 'Persist',
    intent: 'storage',
    ownedPaths: ['src/lib/theme-storage.ts'],
    dependsOn: [],
    assumes: [],
    acceptance: { testCommand: 'npm test -- storage', testFiles: ['src/lib/theme-storage.test.ts'], manualChecks: [] },
    estimateMinutes: 30,
  },
]

let app
let baseUrl
let aliceRepo
let bobRepo

/** Drives the server exactly as the plugin does: bearer participant token. */
const command = (repoPath, cmd) => runCommand(readConfig(repoPath), cmd)

/** Browser-side calls, authenticated by the session cookie. */
async function asUser(cookie, path, init = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    ...init,
    headers: init.body
      ? { 'content-type': 'application/json', cookie, ...init.headers }
      : { cookie, ...init.headers },
  })
  const payload = await response.json()
  if (!response.ok) throw new Error(`${payload.error}: ${payload.message}`)
  return payload
}

/** Signs in over the loopback-only dev route and returns the session cookie. */
async function devLogin(login) {
  const response = await fetch(new URL('/auth/dev', baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login }),
  })
  assert.equal(response.ok, true, 'dev login should be available in tests')
  const cookie = response.headers.get('set-cookie')
  return cookie.split(';')[0]
}

/** The real pairing flow: mint a one-time code, redeem it for this checkout. */
async function attach(cookie, sessionRef, repoPath) {
  const { token } = await asUser(cookie, `/api/sessions/${sessionRef}/join-token`, {
    method: 'POST',
  })
  const result = await pair(baseUrl, token, repoPath)
  writeConfig(repoPath, {
    serverUrl: baseUrl,
    sessionRef: result.sessionRef,
    participantId: result.participantId,
    participantToken: result.participantToken,
    githubLogin: result.githubLogin,
    displayName: result.displayName,
    repoPath,
  })
  return { ...result, token }
}

/** Runs the hook binary the way Claude Code runs it: JSON on stdin, JSON on stdout. */
function runHookEvent(cwd, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [HOOK], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Keep cursors and preferences out of the developer's real ~/.session-share.
      env: { ...process.env, SESSION_SHARE_HOME: stateDir },
    })
    let stdout = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.on('error', reject)
    child.on('close', () => {
      try {
        resolve(stdout.trim() ? JSON.parse(stdout) : null)
      } catch (error) {
        reject(new Error(`hook wrote non-JSON: ${stdout}`, { cause: error }))
      }
    })
    child.stdin.end(JSON.stringify({ cwd, ...payload }))
  })
}

const runHook = (cwd, toolName, toolInput) =>
  runHookEvent(cwd, { hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput })

let aliceCookie
let bobCookie
let stateDir

before(async () => {
  app = createApp({ dbPath: ':memory:', auth: { devLogin: true, secret: 'test-secret' } })
  baseUrl = await app.listen(0)

  aliceRepo = mkdtempSync(join(tmpdir(), 'ss-alice-'))
  bobRepo = mkdtempSync(join(tmpdir(), 'ss-bob-'))
  stateDir = mkdtempSync(join(tmpdir(), 'ss-home-'))

  aliceCookie = await devLogin('alice')
  bobCookie = await devLogin('bob')

  await asUser(aliceCookie, '/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ slug: 'hooked', title: 'Dark mode', repo: REPO, issueRef: null }),
  })

  await attach(aliceCookie, 'hooked', aliceRepo)
  await attach(bobCookie, 'hooked', bobRepo)

  const proposal = await command(aliceRepo, {
    type: 'decomposition.propose',
    contract,
    tasks,
    participantCount: 2,
    issueRef: null,
  })
  assert.equal(proposal.validation.ok, true)

  await command(aliceRepo, {
    type: 'decomposition.approve',
    decompositionId: proposal.decompositionId,
  })
  await command(bobRepo, {
    type: 'decomposition.approve',
    decompositionId: proposal.decompositionId,
  })
  await command(aliceRepo, {
    type: 'contract.committed',
    branch: 'ss/hooked/contract',
    commitSha: 'abc123',
    prNumber: null,
  })
  await command(aliceRepo, { type: 'task.claim', taskId: 'theme-toggle' })
})

after(async () => {
  await app.close()
  rmSync(aliceRepo, { recursive: true, force: true })
  rmSync(bobRepo, { recursive: true, force: true })
  rmSync(stateDir, { recursive: true, force: true })
})

describe('path handling', () => {
  it('pulls the target out of each edit tool shape', () => {
    assert.deepEqual(extractPaths({ file_path: 'a.ts' }), ['a.ts'])
    assert.deepEqual(extractPaths({ notebook_path: 'nb.ipynb' }), ['nb.ipynb'])
    assert.deepEqual(extractPaths({}), [])
    assert.deepEqual(extractPaths(undefined), [])
  })

  it('rewrites an absolute path to repo-relative', () => {
    assert.equal(toRepoRelative('/repo', '/repo/src', '/repo/src/a.ts'), 'src/a.ts')
    assert.equal(toRepoRelative('/repo', '/repo/src', 'a.ts'), 'src/a.ts')
  })
})

describe('pairing a checkout', () => {
  it('refuses a command with no credential at all', async () => {
    const response = await fetch(new URL('/api/commands', baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionRef: 'hooked', command: { type: 'task.claim', taskId: null } }),
    })
    assert.equal(response.status, 401)
  })

  it('burns a join code after one use', async () => {
    const { token } = await asUser(bobCookie, '/api/sessions/hooked/join-token', { method: 'POST' })
    const third = mkdtempSync(join(tmpdir(), 'ss-third-'))
    await pair(baseUrl, token, third)

    await assert.rejects(
      () => pair(baseUrl, token, third),
      /expired or has already been used/,
      'a second redemption must fail',
    )
    rmSync(third, { recursive: true, force: true })
  })

  it('rejects an unknown code', async () => {
    await assert.rejects(() => pair(baseUrl, 'ssj_not_a_real_code', aliceRepo), /expired or has already/)
  })

  it('binds the checkout to whoever minted the code, not to what the client claims', async () => {
    const config = readConfig(bobRepo)
    assert.equal(config.githubLogin, 'bob')
    assert.equal(config.displayName, 'Bob')
    assert.ok(config.participantToken, 'the checkout holds a bearer token, not a raw id')
  })

  it('refuses a second checkout in the same working tree', async () => {
    const { token } = await asUser(bobCookie, '/api/sessions/hooked/join-token', { method: 'POST' })
    await assert.rejects(
      () => pair(baseUrl, token, aliceRepo),
      /separate clone or git worktree/,
      'two agents in one tree must be refused',
    )
  })

  it('keeps a participant token scoped to its own session', async () => {
    await asUser(aliceCookie, '/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ slug: 'other', title: 'Other', repo: REPO, issueRef: null }),
    })
    const response = await fetch(new URL('/sessions/other/snapshot', baseUrl), {
      headers: { authorization: `Bearer ${readConfig(aliceRepo).participantToken}` },
    })
    assert.equal(response.status, 403)
  })
})

describe('the hook against a live session', () => {
  it('allows the holder to edit inside their own lease', async () => {
    const output = await runHook(aliceRepo, 'Edit', {
      file_path: join(aliceRepo, 'src/components/theme-toggle/index.tsx'),
    })
    assert.equal(output, null, 'no output means the edit proceeds')
  })

  it('blocks another dev from editing inside that lease', async () => {
    const output = await runHook(bobRepo, 'Edit', {
      file_path: join(bobRepo, 'src/components/theme-toggle/index.tsx'),
    })
    assert.equal(output.hookSpecificOutput.permissionDecision, 'deny')
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /owned by Alice/)
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /\/ss:request/)
  })

  it('blocks a contract file even for the task holder', async () => {
    const output = await runHook(aliceRepo, 'Write', {
      file_path: join(aliceRepo, 'src/lib/theme-types.ts'),
    })
    assert.equal(output.hookSpecificOutput.permissionDecision, 'deny')
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /frozen/)
  })

  it('leaves unowned files alone', async () => {
    const output = await runHook(bobRepo, 'Write', { file_path: join(bobRepo, 'README.md') })
    assert.equal(output, null)
  })

  it('ignores tools that do not write files', async () => {
    const output = await runHook(bobRepo, 'Read', {
      file_path: join(bobRepo, 'src/components/theme-toggle/index.tsx'),
    })
    assert.equal(output, null, 'reading someone else task is fine')
  })

  it('opens the path once the holder grants a handoff', async () => {
    const path = 'src/components/theme-toggle/index.tsx'
    const { request } = await command(bobRepo, {
      type: 'handoff.request',
      path,
      reason: 'one prop',
    })
    await command(aliceRepo, {
      type: 'handoff.resolve',
      requestId: request.id,
      granted: true,
    })

    const output = await runHook(bobRepo, 'Edit', { file_path: join(bobRepo, path) })
    assert.equal(output, null, 'a granted handoff must open exactly that path')
  })

  it('fails open when the coordination server is unreachable', async () => {
    const orphan = mkdtempSync(join(tmpdir(), 'ss-orphan-'))
    writeConfig(orphan, {
      serverUrl: 'http://127.0.0.1:1',
      sessionRef: 'hooked',
      participantId: 'nobody',
      githubLogin: 'nobody',
      displayName: 'Nobody',
      repoPath: orphan,
    })

    const output = await runHook(orphan, 'Edit', { file_path: join(orphan, 'src/anything.ts') })
    assert.equal(output, null, 'a down server must never wedge a developer')
    rmSync(orphan, { recursive: true, force: true })
  })

  it('does nothing in a repo that never joined a session', async () => {
    const loose = mkdtempSync(join(tmpdir(), 'ss-loose-'))
    const output = await runHook(loose, 'Edit', { file_path: join(loose, 'src/anything.ts') })
    assert.equal(output, null)
    rmSync(loose, { recursive: true, force: true })
  })
})

/**
 * The room as a terminal: a message sent as a directive has to arrive inside
 * the other person's Claude Code, not merely on their screen.
 */
describe('directives from the room', () => {
  const say = (repo, body, extra = {}) =>
    command(repo, { type: 'chat.post', body, taskRef: null, asAgent: false, ...extra })

  const stop = (repo, extra = {}) => runHookEvent(repo, { hook_event_name: 'Stop', ...extra })

  it('starts caught up, so joining does not replay the whole room at the agent', async () => {
    await say(aliceRepo, 'chatter from before Bob was listening', { directive: true })
    assert.equal(await stop(bobRepo), null, 'the first pull only sets the mark')
    assert.equal(await stop(bobRepo), null, 'and nothing older than it is delivered')
  })

  it('hands a directive to the other agent when its turn ends', async () => {
    await say(aliceRepo, 'add a test for the empty list case', { directive: true })

    const output = await stop(bobRepo)
    assert.equal(output.decision, 'block', 'blocking is what makes Claude keep working')
    assert.match(output.reason, /add a test for the empty list case/)
    assert.match(output.reason, /Alice/, 'the agent should know who is asking')
  })

  it('delivers each directive exactly once', async () => {
    assert.equal(await stop(bobRepo), null)
  })

  it('leaves ordinary chat in the room', async () => {
    await say(aliceRepo, 'grabbing coffee, back in five')
    assert.equal(await stop(bobRepo), null, 'talking to a person must not drive their agent')
  })

  it('never hands your own directive back to you', async () => {
    await say(aliceRepo, 'do the thing', { directive: true })
    assert.equal(await stop(aliceRepo), null)
  })

  it('aims a mentioned directive at that participant only', async () => {
    await say(aliceRepo, '@bob rebase onto the contract branch', { directive: true })
    assert.equal(await stop(aliceRepo), null, 'not addressed to Alice')

    const output = await stop(bobRepo)
    assert.match(output.reason, /rebase onto the contract branch/)
  })

  it('does not block twice in one turn', async () => {
    await say(aliceRepo, 'and update the README', { directive: true })
    assert.equal(
      await stop(bobRepo, { stop_hook_active: true }),
      null,
      'a second block in the same turn is a loop, not a delivery',
    )
  })

  it('rides along with the human when they type instead', async () => {
    const output = await runHookEvent(bobRepo, { hook_event_name: 'UserPromptSubmit' })
    assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit')
    assert.match(output.hookSpecificOutput.additionalContext, /update the README/)
  })

  it('fails open when the server cannot be reached', async () => {
    const orphan = mkdtempSync(join(tmpdir(), 'ss-orphan-room-'))
    writeConfig(orphan, {
      serverUrl: 'http://127.0.0.1:1',
      sessionRef: 'hooked',
      participantId: 'nobody',
      githubLogin: 'nobody',
      displayName: 'Nobody',
      repoPath: orphan,
    })
    assert.equal(await stop(orphan), null)
    assert.equal(await stop(orphan), null)
    rmSync(orphan, { recursive: true, force: true })
  })
})
