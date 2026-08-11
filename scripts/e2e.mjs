/**
 * The whole product, driven the way two people actually drive it.
 *
 *   pnpm e2e
 *
 * Nothing here reaches into the service. Every step goes through something a
 * user touches: the MCP tools their Claude Code calls, the HTTP the board
 * calls, and the hook binary Claude Code runs between turns. That is the point
 * -- the unit tests all passed while the board's approve button was dead,
 * because no test had ever pressed it.
 *
 * Two throwaway git repos, one daemon on a spare port, cleaned up at the end.
 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MCP = join(ROOT, 'packages/plugin/dist/mcp.js')
const HOOK = join(ROOT, 'packages/plugin/dist/hook.js')
const PORT = process.env.SESSION_SHARE_E2E_PORT ?? '4377'

const dim = (s) => `\x1b[2m${s}\x1b[0m`
const bold = (s) => `\x1b[1m${s}\x1b[0m`

let failures = 0
let step = 0
const say = (t) => console.log(`\n${bold(`${++step}. ${t}`)}`)
const ok = (s) => console.log(`   \x1b[32m✓\x1b[0m ${s}`)
const note = (s) => console.log(`   ${dim(s)}`)
const bad = (s) => {
  console.log(`   \x1b[31m✗ ${s}\x1b[0m`)
  failures++
}
const check = (cond, good, ill) => (cond ? ok(good) : bad(ill ?? good))

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

const dirs = []
const clients = []
let homeDirs = []

function repo(name, files) {
  const dir = mkdtempSync(join(tmpdir(), `ss-e2e-${name}-`))
  dirs.push(dir)
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(path)), { recursive: true })
    writeFileSync(join(dir, path), contents)
  }
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync(
    'git',
    ['-c', 'user.email=e2e@test', '-c', 'user.name=E2E', 'commit', '-qm', 'init'],
    { cwd: dir },
  )
  return dir
}

async function claudeCode(repoPath, home, login) {
  homeDirs.push(home)
  const client = new Client({ name: 'e2e', version: '1' })
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [MCP],
      stderr: 'ignore',
      env: {
        ...process.env,
        SESSION_SHARE_REPO: repoPath,
        SESSION_SHARE_HOME: home,
        SESSION_SHARE_PORT: PORT,
        SESSION_SHARE_LOGIN: login,
        SESSION_SHARE_NO_OPEN: '1',
      },
    }),
  )
  clients.push(client)
  return {
    async call(name, args = {}) {
      const result = await client.callTool({ name, arguments: args })
      const body = result.content.map((c) => c.text).join('\n')
      if (result.isError) throw new Error(body)
      return body
    },
  }
}

/** A turn ending in that person's Claude Code. Returns what the room handed it. */
function turnEnds(cwd, home) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK], {
      cwd,
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, SESSION_SHARE_HOME: home },
    })
    let out = ''
    child.stdout.on('data', (c) => (out += c))
    child.on('error', reject)
    child.on('close', () => {
      const parsed = out.trim() ? JSON.parse(out) : null
      resolve(parsed?.reason ?? null)
    })
    child.stdin.end(JSON.stringify({ cwd, hook_event_name: 'Stop' }))
  })
}

/** Exactly what the board does: HTTP with the participant token from the invite. */
function board(repoPath) {
  const config = JSON.parse(readFileSync(join(repoPath, '.session-share/session.json'), 'utf8'))
  const request = async (path, init) => {
    const response = await fetch(new URL(path, config.serverUrl), {
      ...init,
      headers: {
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        authorization: `Bearer ${config.participantToken}`,
      },
    })
    const payload = await response.json()
    if (!response.ok) throw new Error(payload.message ?? payload.error ?? response.statusText)
    return payload
  }
  return {
    config,
    me: () => request('/api/me'),
    snapshot: () => request(`/sessions/${config.sessionRef}/snapshot`),
    command: (command) =>
      request('/api/commands', {
        method: 'POST',
        body: JSON.stringify({ sessionRef: config.sessionRef, command }),
      }).then((r) => r.data),
  }
}

const TODO_APP = {
  'README.md': '# todo\n',
  'src/lib/todos.js': 'export const createStore = () => ({ items: [] })\n',
  'src/components/todo-list/render.js': 'export const renderTodos = () => ""\n',
  'docs/notes.md': '# notes\n',
  'package.json': JSON.stringify({ name: 'todo', scripts: { test: 'node --test' } }, null, 2),
}

// A split a planner would plausibly produce for this repo.
const CONTRACT = {
  summary: 'Due-date shape shared by storage and rendering',
  files: [
    {
      path: 'src/lib/due-types.js',
      purpose: 'the due-date field and its helpers',
      contents: 'export const isOverdue = (todo, now) => Boolean(todo.dueAt) && todo.dueAt < now\n',
    },
  ],
}

const TASKS = [
  {
    id: 'due-storage',
    title: 'Store a due date on each todo',
    intent: 'Add dueAt to the store and let it be set',
    ownedPaths: ['src/lib/todos.js', 'src/lib/todos.test.js'],
    dependsOn: [],
    assumes: ['isOverdue from src/lib/due-types.js'],
    acceptance: { testCommand: 'node --test src/lib', testFiles: ['src/lib/todos.test.js'], manualChecks: [] },
    estimateMinutes: 45,
  },
  {
    id: 'due-render',
    title: 'Mark overdue todos in the list',
    intent: 'Render the due date and flag overdue items',
    ownedPaths: ['src/components/todo-list/**'],
    dependsOn: [],
    assumes: ['isOverdue from src/lib/due-types.js'],
    acceptance: {
      testCommand: 'node --test src/components',
      testFiles: ['src/components/todo-list/render.test.js'],
      manualChecks: [],
    },
    estimateMinutes: 40,
  },
  {
    id: 'due-docs',
    title: 'Document due dates',
    intent: 'Explain the field and the overdue rule',
    ownedPaths: ['docs/due-dates.md'],
    dependsOn: ['due-storage', 'due-render'],
    assumes: [],
    acceptance: { testCommand: 'node --test docs', testFiles: [], manualChecks: ['reads correctly'] },
    estimateMinutes: 15,
  },
]

// ---------------------------------------------------------------------------

const scratch = mkdtempSync(join(tmpdir(), 'ss-e2e-home-'))
dirs.push(scratch)
const aliceHome = join(scratch, 'alice')
const bobHome = join(scratch, 'bob')

try {
  console.log(bold('\nsession-share — end to end\n'))
  note(`daemon on port ${PORT}, state under ${scratch}`)

  // A daemon left over from a previous run holds a different secret, so every
  // invite this run mints would be unredeemable. Say so before doing any work.
  const occupied = await fetch(`http://127.0.0.1:${PORT}/healthz`).catch(() => null)
  if (occupied) {
    throw new Error(
      `something is already listening on ${PORT}. Stop it (lsof -ti :${PORT} | xargs kill) or set SESSION_SHARE_E2E_PORT.`,
    )
  }

  // -- 1 ---------------------------------------------------------------------
  say('Alice hosts from her clone')
  const aliceRepo = repo('alice', TODO_APP)
  const alice = await claudeCode(aliceRepo, aliceHome, 'alice')
  const hosted = await alice.call('ss_host', { title: 'Add due dates' })
  const invite = hosted.match(/ssx_[A-Za-z0-9_-]+/)?.[0]
  check(Boolean(invite), 'session created and this checkout attached')
  check(!/127\.0\.0\.1/.test(invite ?? ''), 'the invite carries a reachable address')

  // -- 2 ---------------------------------------------------------------------
  say('Bob joins from his own clone')
  const bobRepo = repo('bob', TODO_APP)
  const bob = await claudeCode(bobRepo, bobHome, 'bob')
  await bob.call('ss_join', { code: invite })
  const bobBoard = board(bobRepo)
  const seen = await bobBoard.snapshot()
  check(seen.participants.length === 2, 'both are in the session')

  // -- 3 ---------------------------------------------------------------------
  say("Bob's board asks who it is")
  const me = await bobBoard.me()
  check(me.user?.githubLogin === 'bob', 'the board knows which seat is its own')
  check(
    seen.participants.some((p) => p.userId === me.user?.id),
    'and can match itself to a participant — without this, approve is dead',
  )

  // -- 4 ---------------------------------------------------------------------
  say('Bob types the brief on the board and presses plan')
  const requested = await bobBoard.command({
    type: 'plan.request',
    goal: 'Add due dates to todos, with overdue ones marked in the list.',
    issueRef: null,
    plannerId: null,
  })
  const planner = seen.participants.find((p) => p.id === requested.plannerId)
  check(planner?.displayName === 'Alice', 'it went to the lead, who has a checkout')

  const briefing = await turnEnds(aliceRepo, aliceHome)
  check(
    briefing?.includes('Add due dates to todos'),
    "and arrived inside Alice's Claude Code as work to do",
  )

  // -- 5 ---------------------------------------------------------------------
  say("Alice's agent reads the repo and proposes a split")
  const proposed = JSON.parse(await alice.call('ss_propose', { contract: CONTRACT, tasks: TASKS }))
  check(proposed.accepted === true, `the validator accepted it (${TASKS.length} tasks)`)
  check(
    proposed.assigned?.length === TASKS.length,
    'and it came back already split between the two of them',
  )
  for (const line of proposed.assigned ?? []) note(`${line.task} → ${line.to}`)

  const afterPropose = await bobBoard.snapshot()
  const first = new Map(afterPropose.decomposition.assignments.map((a) => [a.taskId, a.participantId]))
  check(
    first.get('due-storage') !== first.get('due-render'),
    'the two tasks that can run at once went to different people',
  )

  // -- 6 ---------------------------------------------------------------------
  say('Bob drags a card to himself on the board')
  const target = 'due-storage'
  const moved = await bobBoard.command({
    type: 'task.assign',
    taskId: target,
    participantId: me.user.id === null ? null : seen.participants.find((p) => p.githubLogin === 'bob').id,
  })
  const pin = moved.assignments.find((a) => a.taskId === target)
  check(pin.manual === true, `${target} is now pinned to Bob`)

  const rebalanced = new Map(moved.assignments.map((a) => [a.taskId, a.participantId]))
  check(
    rebalanced.get('due-render') !== rebalanced.get(target),
    'and the rest rebalanced around it rather than piling up',
  )

  // -- 7 ---------------------------------------------------------------------
  say('Both approve on the board')
  const aliceBoard = board(aliceRepo)
  const decompositionId = afterPropose.decomposition.id
  const one = await aliceBoard.command({ type: 'decomposition.approve', decompositionId })
  check(one.satisfied === false, 'one approval is not enough with two people')
  const two = await bobBoard.command({ type: 'decomposition.approve', decompositionId })
  check(two.satisfied === true, 'the second one settles it')

  const live = await bobBoard.snapshot()
  check(
    live.tasks.length === TASKS.length && live.tasks.every((t) => t.assigneeId),
    'tasks are live and every one knows whose it is',
  )

  // -- 8 ---------------------------------------------------------------------
  say('Each agent is told what it owns, without anyone saying so')
  const aliceBrief = await turnEnds(aliceRepo, aliceHome)
  const bobBrief = await turnEnds(bobRepo, bobHome)
  check(/The split was approved/.test(aliceBrief ?? ''), 'Alice got her list')
  check(/The split was approved/.test(bobBrief ?? ''), 'Bob got his')
  check(
    (bobBrief ?? '').includes(target),
    `and Bob's names ${target}, the card he moved to himself`,
  )

  // -- 9 ---------------------------------------------------------------------
  say('Alice lands the contract; the others hear that they can start')
  await alice.call('ss_land_contract')
  const built = await bobBoard.snapshot()
  check(built.session.phase === 'build', 'the session is in build')
  const wake = await turnEnds(bobRepo, bobHome)
  check(/claimable now/.test(wake ?? ''), 'Bob was told to stop waiting')

  // -- 10 --------------------------------------------------------------------
  say('Each runs /ss:next and gets their own work')
  const bobTask = await bob.call('ss_claim', {})
  const aliceTask = await alice.call('ss_claim', {})
  check(bobTask.includes(target), `Bob got ${target}, the one assigned to him`)
  check(aliceTask.includes('due-render'), 'Alice got the other one')

  const claimed = await bobBoard.snapshot()
  const held = claimed.tasks.filter((t) => t.ownerId)
  check(held.length === 2, 'both are held')
  check(
    held.every((task) => task.ownerId === task.assigneeId),
    'and everyone is working on what they were given',
  )

  // -- 11 --------------------------------------------------------------------
  say('A second plan runs at the same time, in a worktree')
  const worktree = await alice.call('ss_worktree', { title: 'Add tags' })
  const path = worktree.match(/at (\/\S+) on/)?.[1] ?? worktree.match(/^(\/\S+) already/m)?.[1]
  check(Boolean(path), 'a separate working tree exists for the second session')
  note(worktree.split('\n')[0])

  // Same person, same machine: the worktree shares her ~/.session-share, so it
  // shares the daemon too. A second one would be a second server.
  const second = await claudeCode(path, aliceHome, 'alice')
  const secondHost = await second.call('ss_host', { title: 'Add tags' })
  check(/Hosting "Add tags"/.test(secondHost), 'and it hosts its own session on the same daemon')

  const sessions = await (
    await fetch(new URL('/api/sessions', aliceBoard.config.serverUrl), {
      headers: { authorization: `Bearer ${aliceBoard.config.participantToken}` },
    })
  ).json()
  check(sessions.sessions.length >= 1, 'the first session is untouched by the second')
  const stillBuilding = await aliceBoard.snapshot()
  check(stillBuilding.session.phase === 'build', 'still in build, with its tasks held')
} catch (error) {
  bad(`threw: ${error.message}`)
  if (process.env.SESSION_SHARE_E2E_STACK) console.error(error)
} finally {
  for (const client of clients) await client.close().catch(() => {})
  for (const home of homeDirs) {
    try {
      const info = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8'))
      process.kill(info.pid)
    } catch {}
  }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })

  console.log(
    failures === 0
      ? `\n\x1b[32mall ${step} steps passed\x1b[0m\n`
      : `\n\x1b[31m${failures} failure(s)\x1b[0m\n`,
  )
  process.exit(failures === 0 ? 0 : 1)
}
