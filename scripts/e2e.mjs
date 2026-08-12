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

/** A second ticket, scoped away from the first: two tickets may not share files. */
const TAG_TASKS = [
  {
    id: 'tag-storage',
    title: 'Store tags on a todo',
    intent: 'A tag list per todo',
    ownedPaths: ['src/lib/tags.js', 'src/lib/tags.test.js'],
    dependsOn: [],
    assumes: [],
    acceptance: { testCommand: 'node --test src/lib', testFiles: ['src/lib/tags.test.js'], manualChecks: [] },
    estimateMinutes: 40,
  },
  {
    id: 'tag-filter',
    title: 'Filter the list by tag',
    intent: 'Pick a tag and show only those',
    ownedPaths: ['src/components/tag-filter/**'],
    dependsOn: [],
    assumes: [],
    acceptance: {
      testCommand: 'node --test src/components',
      testFiles: ['src/components/tag-filter/filter.test.js'],
      manualChecks: [],
    },
    estimateMinutes: 35,
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
  const aliceBoardEarly = board(aliceRepo)
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
  say('Bob writes a ticket in the Plan column')
  const opened = await bobBoard.command({
    type: 'ticket.create',
    title: 'Add tags to todos',
    body: 'A tag list on each todo and a way to filter by one.',
  })
  check(opened.ticket.state === 'plan', 'it lands in Plan, with Bob in it')

  const invited = await turnEnds(aliceRepo, aliceHome)
  check(
    invited === null,
    'and Alice is told without her agent being hijacked into joining',
    'the invitation must not drive an agent',
  )
  const room = (await aliceBoardEarly.snapshot()).chat.at(-1)
  check(/Join it on the board/.test(room?.body ?? ''), 'the invitation is in the room')

  say('Alice joins it, which is the whole agreement')
  const joinedTicket = await aliceBoardEarly.command({
    type: 'ticket.join',
    ticketId: opened.ticket.id,
  })
  check(joinedTicket.ticket.members.length === 2, 'both are in')
  check(joinedTicket.ticket.state === 'splitting', 'and it starts splitting itself')

  // The author's agent does the splitting: they wrote the ticket, so they know
  // what it meant.
  const toSplit = await turnEnds(bobRepo, bobHome)
  check(/Split the ticket/.test(toSplit ?? ''), "the author's agent was handed the split")
  check(
    /goes on the board for one of them to start/.test(toSplit ?? ''),
    'and told where the split goes',
  )

  say("Bob's agent proposes it; the split is shown before it runs")
  const ticketSplit = JSON.parse(
    await bob.call('ss_propose', {
      contract: CONTRACT,
      tasks: TAG_TASKS,
      ticketId: opened.ticket.id,
    }),
  )
  check(ticketSplit.accepted === true, 'the validator still runs')

  const ready = await bobBoard.snapshot()
  check(
    ready.tickets.find((t) => t.id === opened.ticket.id)?.state === 'proposed',
    'the split is put in front of a person before it runs',
  )
  check(
    ready.tasks.filter((t) => t.ticketId === opened.ticket.id).length === 0,
    'and nothing is running yet',
  )

  say('Bob changes who does what, then presses start')
  const reassigned = await bobBoard.command({
    type: 'task.assign',
    taskId: TAG_TASKS[0].id,
    participantId: seen.participants.find((p) => p.githubLogin === 'bob').id,
  })
  check(
    reassigned.assignments.find((a) => a.taskId === TAG_TASKS[0].id).manual === true,
    'the change sticks',
  )
  await bobBoard.command({ type: 'ticket.approve', ticketId: opened.ticket.id })

  const afterSplit = await bobBoard.snapshot()
  const ticketTasks = afterSplit.tasks.filter((t) => t.ticketId === opened.ticket.id)
  check(ticketTasks.length === TAG_TASKS.length, 'its tasks are live immediately')
  check(
    ticketTasks.every((t) => t.assigneeId),
    'shared out between the two who joined, with nothing approved',
  )
  check(
    afterSplit.tickets.find((t) => t.id === opened.ticket.id)?.state === 'building',
    'and the card moved itself to Building',
  )
  check(
    ticketTasks.find((t) => t.id === TAG_TASKS[0].id)?.assigneeId ===
      seen.participants.find((p) => p.githubLogin === 'bob').id,
    'with the change he made, not the original arrangement',
  )

  const briefed = await turnEnds(aliceRepo, aliceHome)
  check(/ss_claim -> do the work/.test(briefed ?? ''), "Alice's agent was told to run the whole loop")

  say('Both finish their tasks; the ticket asks to be run for real')
  // Its tasks only become claimable once the seam is on a branch.
  await bob.call('ss_land_contract')
  for (const spec of TAG_TASKS) {
    const who = afterSplit.tasks.find((t) => t.id === spec.id)?.assigneeId
    const hand = who === seen.participants.find((p) => p.githubLogin === 'bob').id ? bobBoard : aliceBoardEarly
    await hand.command({ type: 'task.claim', taskId: spec.id })
    await hand.command({ type: 'task.merged', taskId: spec.id })
  }

  const assembled = await bobBoard.snapshot()
  check(
    assembled.tickets.find((t) => t.id === opened.ticket.id)?.state === 'verify',
    'landing every task is not the same as it working, so it goes to verify',
  )

  const toRun = await turnEnds(bobRepo, bobHome)
  check(/exercise the feature end to end/.test(toRun ?? ''), 'and someone is asked to run it')
  check(!/ss_ship/.test(toRun ?? ''), 'with no mention of a PR yet')

  say('It is broken, so the work it names opens back up')
  const failed = await bobBoard.command({
    type: 'ticket.verified',
    ticketId: opened.ticket.id,
    passed: false,
    how: 'node --test plus a run of the CLI',
    summary: 'Filtering by a tag returns nothing once more than one tag is set.',
    broke: ['tag-filter'],
  })
  check(failed.ticket.state === 'building', 'the card goes back to the people who built it')

  const reopened = await bobBoard.snapshot()
  check(
    reopened.tasks.find((t) => t.id === 'tag-filter')?.state === 'ready',
    'the named task is claimable again, not merged and untouchable',
  )
  check(
    reopened.tasks.find((t) => t.id === 'tag-storage')?.state === 'merged',
    'and the task the run did not blame is left alone',
  )

  const broken = await turnEnds(aliceRepo, aliceHome)
  check(/returns nothing once more than one tag/.test(broken ?? ''), 'with what was actually seen')
  check(/tag-filter/.test(broken ?? ''), 'and which task to pick up')

  say('The fix lands and the run is asked for again, on its own')
  await bobBoard.command({ type: 'task.claim', taskId: 'tag-filter' })
  await bobBoard.command({ type: 'task.merged', taskId: 'tag-filter' })

  const backToVerify = await bobBoard.snapshot()
  check(
    backToVerify.tickets.find((t) => t.id === opened.ticket.id)?.state === 'verify',
    'landing the fix sends the ticket back to be run',
  )
  const rerun = await turnEnds(bobRepo, bobHome)
  check(/Run it again/.test(rerun ?? ''), 'and nobody had to ask for the second run')
  check(/more than one tag/.test(rerun ?? ''), 'with the failure it has to disprove')

  say('Re-run and working, it reaches review')
  const verified = await bobBoard.command({
    type: 'ticket.verified',
    ticketId: opened.ticket.id,
    passed: true,
    how: 'node --test plus a run of the CLI',
    summary: 'Filters correctly with several tags.',
  })
  check(verified.ticket.state === 'review', 'only a passing run moves it on')

  say('The session takes another ticket after that one is done')
  /**
   * The phase used to latch: finishing a ticket moved the whole session to
   * `integrate`, and every split after that was refused with "this session is
   * past planning". A session is for a repo, not for one piece of work, so the
   * second ticket has to behave exactly like the first.
   */
  const secondTicket = await aliceBoardEarly.command({
    type: 'ticket.create',
    title: 'Archive completed todos',
    body: 'Hide anything ticked off, with a way to see them again.',
  })
  await bobBoard.command({ type: 'ticket.join', ticketId: secondTicket.ticket.id })

  const secondSplit = JSON.parse(
    await alice.call('ss_propose', {
      contract: {
        summary: 'Archive flag shared by the store and the list',
        files: [
          {
            path: 'src/lib/archive-types.js',
            purpose: 'what counts as archived',
            contents: 'export const isArchived = (todo) => Boolean(todo.archivedAt)\n',
          },
        ],
      },
      tasks: [
        {
          id: 'archive-store',
          title: 'Archive a todo',
          intent: 'Stamp archivedAt and keep it out of the default list',
          ownedPaths: ['src/lib/archive.js', 'src/lib/archive.test.js'],
          dependsOn: [],
          assumes: ['isArchived from src/lib/archive-types.js'],
          acceptance: {
            testCommand: 'node --test src/lib',
            testFiles: ['src/lib/archive.test.js'],
            manualChecks: [],
          },
          estimateMinutes: 35,
        },
      ],
      ticketId: secondTicket.ticket.id,
    }),
  )
  check(secondSplit.accepted === true, 'a finished ticket does not close the session to new work')

  const afterSecond = await aliceBoardEarly.snapshot()
  check(
    afterSecond.tickets.find((t) => t.id === secondTicket.ticket.id)?.state === 'proposed',
    'the second ticket reaches its own split like the first',
  )
  check(
    afterSecond.tickets.find((t) => t.id === opened.ticket.id)?.state === 'review',
    'without disturbing the one already in review',
  )

  /**
   * The session-wide plan-and-approve flow that tickets replaced still exists
   * in the server and has its own tests; it is not exercised here because it is
   * not what anyone does any more.
   */

  say('A ticket nobody wants any more is thrown away, mid-flight')
  const doomed = await aliceBoardEarly.command({
    type: 'ticket.create',
    title: 'Rewrite the CLI in Rust',
    body: 'On reflection, no.',
  })
  await bobBoard.command({ type: 'ticket.join', ticketId: doomed.ticket.id })

  // Deleted by the one who did not open it, to prove there is no owner check.
  const gone = await bobBoard.command({ type: 'ticket.delete', ticketId: doomed.ticket.id })
  check(gone.ticketId === doomed.ticket.id, 'anyone in the room can delete, at any stage')

  const afterDelete = await aliceBoardEarly.snapshot()
  check(
    !afterDelete.tickets.some((t) => t.id === doomed.ticket.id),
    'the card is gone from everyone else\'s board too',
  )
  check(
    afterDelete.tickets.some((t) => t.id === opened.ticket.id),
    'and the tickets around it are untouched',
  )

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
    await fetch(new URL('/api/sessions', aliceBoardEarly.config.serverUrl), {
      headers: { authorization: `Bearer ${aliceBoardEarly.config.participantToken}` },
    })
  ).json()
  check(sessions.sessions.length >= 1, 'the first session is untouched by the second')
  const stillBuilding = await aliceBoardEarly.snapshot()
  check(
    stillBuilding.tickets.some((t) => t.state === 'review'),
    'the first session still has its verified ticket waiting to ship',
  )
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
