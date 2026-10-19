import { strict as assert } from 'node:assert'
import { execSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { assembledCommit, registerGitTools, verdictCommit } from '../dist/tools-git.js'
import { beginMerge, conflictMarkers } from '../dist/git.js'

/**
 * The git half of finishing a task, against real repositories and a real bare
 * remote. The coordination server is a stub that accepts every command: what
 * is under test here is what happens to people's working trees.
 */
let root
let server
let serverUrl
/** Every command the plugin sent, in order. */
const sent = []
/** Runs as each command arrives, before it is answered: someone acting while the plugin waits. */
let onCommand = null

const sh = (cwd, cmd) => execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'ss-git-'))
  process.env.SESSION_SHARE_HOME = join(root, 'home')
  server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      try {
        const command = JSON.parse(body).command
        sent.push(command)
        onCommand?.(command)
      } catch {}
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: { unblocked: [] } }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  serverUrl = `http://127.0.0.1:${server.address().port}`
})

after(() => {
  server.close()
  rmSync(root, { recursive: true, force: true })
})

function fresh(name, { remote = true } = {}) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  if (remote) sh(dir, 'git init -q --bare -b main origin.git')
  const clone = (who) => {
    const work = join(dir, who)
    if (remote && existsSync(join(dir, 'a'))) {
      sh(dir, `git clone -q origin.git ${who}`)
      sh(work, 'git config user.email b@example.com && git config user.name b')
      return work
    }
    mkdirSync(work)
    sh(work, 'git init -q -b main && git config user.email a@example.com && git config user.name a')
    sh(work, 'echo hi > README && git add . && git commit -qm init')
    if (remote) sh(work, `git remote add origin ${join(dir, 'origin.git')} && git push -q -u origin main`)
    return work
  }
  return { dir, clone }
}

const task = (over = {}) => ({
  id: 't1',
  title: 'T1',
  intent: 'i',
  ownerId: 'me',
  state: 'testing',
  ownedPaths: ['src/t1/**'],
  acceptance: { testCommand: 'true' },
  lastTest: { passed: true },
  ...over,
})

const snapshot = (over = {}) => ({
  session: { slug: 'sx', title: 'T', repo: { baseBranch: 'main' } },
  decomposition: {
    status: 'approved',
    contract: { summary: 'c', files: [{ path: 'src/contract.ts', contents: 'export {}\n' }] },
  },
  tasks: [task()],
  participants: [],
  tickets: [],
  ...over,
})

function tools(work, state) {
  const handlers = {}
  registerGitTools(
    { registerTool: (name, _schema, handler) => (handlers[name] = handler) },
    {
      repoRoot: async () => work,
      config: () => ({
        serverUrl,
        sessionRef: 's',
        participantId: 'me',
        participantToken: 't',
        githubLogin: 'a',
        displayName: 'A',
        repoPath: work,
      }),
      snapshot: async () => (typeof state === 'function' ? state() : state),
      text: (value) => (typeof value === 'string' ? value : JSON.stringify(value)),
    },
  )
  return handlers
}

const write = (work, path, contents = 'x') => {
  mkdirSync(join(work, path, '..'), { recursive: true })
  writeFileSync(join(work, path), contents)
}

describe('finishing a task', () => {
  it('commits only what the task owns, not whatever else was staged', async () => {
    const { clone } = fresh('only-owned')
    const work = clone('a')
    const h = tools(work, snapshot())
    await h.ss_land_contract({})
    await h.ss_start_task({ taskId: 't1' })
    write(work, 'src/t1/x.ts')
    write(work, 'src/elsewhere.ts')
    sh(work, 'git add src/elsewhere.ts')

    const refused = await h.ss_done({ taskId: 't1', summary: 's', force: false })
    assert.match(refused, /outside "t1"/)
    assert.match(refused, /src\/elsewhere.ts/)
    assert.equal(sh(work, 'git branch --show-current'), 'ss/sx/t1', 'nothing moved')

    sh(work, 'git reset -q src/elsewhere.ts')
    const done = await h.ss_done({ taskId: 't1', summary: 's', force: false })
    assert.match(done, /merged into ss\/sx\/contract/)
    assert.deepEqual(sh(work, 'git show --name-only --format= ss/sx/t1').split('\n'), ['src/t1/x.ts'])
    assert.equal(sh(work, 'git status --porcelain'), '?? src/elsewhere.ts', 'left exactly as it was')
  })

  it('understands brace globs, and owned paths that were never created', async () => {
    const { clone } = fresh('braces')
    const work = clone('a')
    const h = tools(work, snapshot({ tasks: [task({ ownedPaths: ['src/{a,b}/**', 'docs/t1.md'] })] }))
    await h.ss_land_contract({})
    await h.ss_start_task({ taskId: 't1' })
    write(work, 'src/a/x.ts')
    write(work, 'src/c/not-mine.ts')

    const done = await h.ss_done({ taskId: 't1', summary: 's', force: false })
    assert.match(done, /merged/)
    assert.deepEqual(sh(work, 'git show --name-only --format= ss/sx/t1').split('\n'), ['src/a/x.ts'])
  })

  it('commits a deletion inside the lease', async () => {
    const { clone } = fresh('deletion')
    const work = clone('a')
    write(work, 'src/t1/old.ts', 'the old implementation\n')
    sh(work, 'git add . && git commit -qm old && git push -q')
    const h = tools(work, snapshot())
    await h.ss_land_contract({})
    await h.ss_start_task({ taskId: 't1' })
    rmSync(join(work, 'src/t1/old.ts'))
    write(work, 'src/t1/new.ts', 'something else entirely\n')

    await h.ss_done({ taskId: 't1', summary: 's', force: false })
    assert.equal(existsSync(join(work, 'src/t1/old.ts')), false)
    assert.match(sh(work, 'git show --name-status --format= ss/sx/t1'), /D\tsrc\/t1\/old.ts/)
  })

  it('finishes in a repository with no remote at all', async () => {
    const { clone } = fresh('no-remote', { remote: false })
    const work = clone('a')
    const h = tools(work, snapshot())
    await h.ss_land_contract({})
    await h.ss_start_task({ taskId: 't1' })
    write(work, 'src/t1/x.ts')

    const done = await h.ss_done({ taskId: 't1', summary: 's', force: false })
    assert.match(done, /merged into ss\/sx\/contract/)
    assert.match(done, /not pushed/)
  })

  it('refuses a task that has already landed', async () => {
    const { clone } = fresh('merged')
    const work = clone('a')
    const h = tools(work, snapshot({ tasks: [task({ state: 'merged' })] }))
    assert.match(await h.ss_done({ taskId: 't1', summary: 's', force: false }), /already merged/)
  })

  it('takes a teammate landing first in its stride', async () => {
    const { clone } = fresh('race')
    const alice = clone('a')
    const two = snapshot({ tasks: [task(), task({ id: 't2', ownedPaths: ['src/t2/**'] })] })
    const ha = tools(alice, two)
    await ha.ss_land_contract({})
    const bob = clone('b')
    const hb = tools(bob, two)

    await ha.ss_start_task({ taskId: 't1' })
    await hb.ss_start_task({ taskId: 't2' })
    write(alice, 'src/t1/x.ts')
    write(bob, 'src/t2/y.ts')

    assert.match(await ha.ss_done({ taskId: 't1', summary: 's', force: false }), /merged/)
    // Bob's local contract branch is behind origin now.
    assert.match(await hb.ss_done({ taskId: 't2', summary: 's', force: false }), /merged/)

    sh(alice, 'git fetch -q origin')
    const landed = sh(alice, 'git ls-tree -r --name-only origin/ss/sx/contract')
    assert.match(landed, /src\/t1\/x.ts/)
    assert.match(landed, /src\/t2\/y.ts/)
  })
})

describe('syncing and shipping', () => {
  it('updates the contract without moving anyone off their branch', async () => {
    const { clone } = fresh('sync')
    const alice = clone('a')
    const two = snapshot({ tasks: [task(), task({ id: 't2', ownedPaths: ['src/t2/**'] })] })
    const ha = tools(alice, two)
    await ha.ss_land_contract({})
    const bob = clone('b')
    const hb = tools(bob, two)
    await hb.ss_start_task({ taskId: 't2' })

    await ha.ss_start_task({ taskId: 't1' })
    write(alice, 'src/t1/x.ts')
    await ha.ss_done({ taskId: 't1', summary: 's', force: false })

    const synced = await hb.ss_sync({})
    assert.match(synced, /now matches origin/)
    assert.equal(sh(bob, 'git branch --show-current'), 'ss/sx/t2', 'still on the task branch')
    assert.equal(sh(bob, 'git rev-parse ss/sx/contract'), sh(bob, 'git rev-parse origin/ss/sx/contract'))
    assert.match(await hb.ss_sync({}), /already up to date/)
  })

  it('ships from a contract branch that was behind origin', async () => {
    const { clone } = fresh('ship')
    const alice = clone('a')
    const two = snapshot({ tasks: [task(), task({ id: 't2', ownedPaths: ['src/t2/**'] })] })
    const ha = tools(alice, two)
    await ha.ss_land_contract({})
    const bob = clone('b')
    const hb = tools(bob, two)
    await hb.ss_land_contract({}) // bob now has a local contract branch

    await ha.ss_start_task({ taskId: 't1' })
    write(alice, 'src/t1/x.ts')
    await ha.ss_done({ taskId: 't1', summary: 's', force: false })

    // Run assembled at what origin has, which bob's local copy is behind.
    const head = sh(bob, 'git fetch -q origin && git rev-parse origin/ss/sx/contract')
    const merged = snapshot({
      tasks: [task({ state: 'merged', ticketId: 'k1' }), task({ id: 't2', state: 'merged', ticketId: 'k1' })],
      tickets: [
        {
          id: 'k1',
          title: 'Pay',
          state: 'review',
          verification: { passed: true, how: 'e2e', summary: 'ok', broke: [], by: 'me', at: 1, commitSha: head, stale: false },
          needsHuman: false,
          humanCheck: null,
          mergedAt: null,
          prNumber: null,
        },
      ],
    })
    const shipped = await tools(bob, merged).ss_ship({})
    assert.doesNotMatch(shipped, /rejected|failed|Not shipped/)
    assert.match(shipped, /ss\/sx\/contract/)
  })
})

describe('worktrees and handoffs', () => {
  it('fast-forwards a branch checked out in another worktree in place, not under it', async () => {
    const { dir, clone } = fresh('worktree')
    const alice = clone('a')
    const two = snapshot({ tasks: [task(), task({ id: 't2', ownedPaths: ['src/t2/**'] })] })
    await tools(alice, two).ss_land_contract({})
    const bob = clone('b')
    const hb = tools(bob, two)
    await hb.ss_start_task({ taskId: 't2' })
    const side = join(dir, 'b-contract')
    sh(bob, `git worktree add -q ${side} ss/sx/contract`)

    const ha = tools(alice, two)
    await ha.ss_start_task({ taskId: 't1' })
    write(alice, 'src/t1/x.ts')
    await ha.ss_done({ taskId: 't1', summary: 's', force: false })

    assert.match(await hb.ss_sync({}), /now matches origin/)
    assert.equal(sh(side, 'git status --porcelain'), '', 'no staged reversal of what landed')
    assert.equal(existsSync(join(side, 'src/t1/x.ts')), true)
  })

  it('says why a fast-forward failed instead of calling it divergence', async () => {
    const { clone } = fresh('dirty-ff')
    const alice = clone('a')
    const two = snapshot({ tasks: [task(), task({ id: 't2', ownedPaths: ['src/t2/**'] })] })
    await tools(alice, two).ss_land_contract({})
    const bob = clone('b')
    const hb = tools(bob, two)
    await hb.ss_land_contract({}) // bob is on the contract branch
    sh(bob, 'git checkout -q main')

    const ha = tools(alice, two)
    await ha.ss_start_task({ taskId: 't1' })
    write(alice, 'src/t1/x.ts', 'from alice')
    await ha.ss_done({ taskId: 't1', summary: 's', force: false })

    sh(bob, 'git checkout -q ss/sx/contract')
    write(bob, 'src/t1/x.ts', 'bob was here, uncommitted')
    await assert.rejects(hb.ss_sync({}), (error) => /overwritten|untracked/.test(error.message) && !/diverged/.test(error.message))
  })

  it('commits a file a handoff opened as part of the task', async () => {
    const { clone } = fresh('handoff')
    const work = clone('a')
    const state = snapshot({
      handoffs: [
        { id: 'h1', path: 'src/shared/x.ts', requesterId: 'me', holderId: 'bob', heldByTaskId: 't9', requesterTaskId: 't1', reason: 'r', status: 'granted', createdAt: 0 },
      ],
    })
    write(work, 'src/shared/x.ts', 'original\n')
    sh(work, 'git add . && git commit -qm shared && git push -q')
    const h = tools(work, state)
    await h.ss_land_contract({})
    await h.ss_start_task({ taskId: 't1' })
    write(work, 'src/t1/x.ts')
    write(work, 'src/shared/x.ts', 'changed under a handoff\n')

    const done = await h.ss_done({ taskId: 't1', summary: 's', force: false })
    assert.match(done, /merged/)
    assert.deepEqual(
      sh(work, 'git show --name-only --format= ss/sx/t1').split('\n').sort(),
      ['src/shared/x.ts', 'src/t1/x.ts'],
    )
  })
})

describe('landing a contract', () => {
  it('refuses a contract file that would land outside the repository', async () => {
    const { dir, clone } = fresh('escape')
    const work = clone('a')
    const h = tools(
      work,
      snapshot({
        decomposition: {
          status: 'approved',
          contract: { summary: 'c', files: [{ path: '../escaped.txt', contents: 'gotcha' }] },
        },
      }),
    )
    await assert.rejects(h.ss_land_contract({}), /outside the repository/)
    assert.equal(existsSync(join(dir, 'escaped.txt')), false)
  })

  it('refuses a contract file aimed into .git, whatever its case', async () => {
    const { clone } = fresh('dotgit')
    const work = clone('a')
    const before = sh(work, 'git config --list --local')
    for (const path of ['.GIT/config', 'sub/../.Git/config', 'nested/.git/hooks/pre-commit']) {
      const h = tools(
        work,
        snapshot({
          decomposition: {
            status: 'approved',
            contract: { summary: 'c', files: [{ path, contents: '[core]\n\tfsmonitor = touch pwned\n' }] },
          },
        }),
      )
      await assert.rejects(h.ss_land_contract({}), /\.git/, path)
    }
    assert.equal(sh(work, 'git config --list --local'), before)
  })
})

/** Whether a merge is in progress in `work`. */
const merging = (work) => {
  try {
    sh(work, 'git rev-parse -q --verify MERGE_HEAD')
    return true
  } catch {
    return false
  }
}

describe('integrating when the contract has moved under a task', () => {
  // No `gh` in these: what is under test is git, and GitHub is not.
  before(() => tools(root, snapshot()).ss_settings({ openPullRequests: false }))
  after(() => tools(root, snapshot()).ss_settings({ openPullRequests: true }))

  /**
   * Bob's task owns src/app.ts; Alice's was granted it by a handoff. Both
   * change the same line, Bob lands first, and Alice's merge conflicts.
   */
  async function collision(name) {
    const { dir, clone } = fresh(name)
    const alice = clone('a')
    write(alice, 'src/app.ts', 'export const greeting = "hello"\n')
    sh(alice, 'git add . && git commit -qm app && git push -q')
    /**
     * The acceptance command is a script outside the repository, so each test
     * decides what "the tests" do: pass, fail, or meddle with the checkout.
     */
    const script = join(dir, 'acceptance.sh')
    writeFileSync(script, 'exit 0\n')
    const acceptance = (body) => writeFileSync(script, `${body}\n`)
    const t1 = task({ lastTest: { passed: true, ranAt: 1 }, acceptance: { testCommand: `sh "${script}"` } })
    const state = snapshot({
      tasks: [t1, task({ id: 't2', ownedPaths: ['src/t2/**', 'src/app.ts'] })],
      handoffs: [
        { id: 'h1', path: 'src/app.ts', requesterId: 'me', holderId: 'me', heldByTaskId: 't2', requesterTaskId: 't1', reason: 'r', status: 'granted', createdAt: 0 },
      ],
    })
    const ha = tools(alice, () => state)
    await ha.ss_land_contract({})
    const bob = clone('b')
    const hb = tools(bob, () => state)
    await ha.ss_start_task({ taskId: 't1' })
    await hb.ss_start_task({ taskId: 't2' })
    write(alice, 'src/t1/x.ts', 'alice\n')
    write(alice, 'src/app.ts', 'export const greeting = "hello, alice"\n')
    write(bob, 'src/t2/y.ts', 'bob\n')
    write(bob, 'src/app.ts', 'export const greeting = "hello, bob"\n')
    assert.match(await hb.ss_done({ taskId: 't2', summary: 's', force: false }), /merged/)
    sent.length = 0
    return { dir, alice, bob, ha, t1, state, acceptance }
  }
  const resolved = 'export const greeting = "hello, alice and bob"\n'
  const head = (work) => sh(work, 'git rev-parse HEAD')
  /** A person writing in the room about t1, as the board would send it. */
  const human = (body, over = {}) => ({
    id: `m${Math.random()}`,
    authorId: 'p2',
    authorKind: 'human',
    body,
    taskRef: 't1',
    mentions: [],
    directive: false,
    createdAt: Date.now() + 1000,
    ...over,
  })
  const done = (h, over = {}) => h.ss_done({ taskId: 't1', summary: 'feat(t1): greet', force: false, ...over })

  it('has the agent resolve, then tests exactly that tree itself and commits and lands it only once it passes', async () => {
    const { alice, ha, t1, acceptance } = await collision('resolve')
    sh(alice, 'git fetch -q origin')
    const contractBefore = sh(alice, 'git rev-parse origin/ss/sx/contract')

    const first = await done(ha)
    assert.match(first, /conflicts with what has landed on ss\/sx\/contract/)
    assert.match(first, /src\/app\.ts/)
    assert.match(first, /Round 1 of 3/)
    // Nothing is lost: the work is committed, pushed, and kept under its own ref.
    const original = sh(alice, 'git rev-parse refs/session-share/sx/t1/original')
    assert.equal(sh(alice, 'git rev-parse origin/ss/sx/t1'), original)
    assert.equal(sh(alice, `git show ${original}:src/app.ts`), 'export const greeting = "hello, alice"')
    // The shared branch never sees a half-done merge; the agent's own branch does, uncommitted.
    assert.equal(sh(alice, 'git rev-parse origin/ss/sx/contract'), contractBefore)
    assert.equal(sh(alice, 'git branch --show-current'), 'ss/sx/t1')
    assert.ok(merging(alice))
    assert.equal(head(alice), original)
    assert.match(readFileSync(join(alice, 'src/app.ts'), 'utf8'), /^<<<<<<< /m)

    assert.match(await done(ha), /Conflict markers are still in:\n {2}src\/app\.ts:1/)

    // A resolution, plus an edit to somebody else's file git had merged by itself, and a stray untracked file.
    write(alice, 'src/app.ts', resolved)
    write(alice, 'src/t2/y.ts', 'alice rewrote this\n')
    write(alice, 'stray.config.js', 'module.exports = {}\n')
    const outside = await done(ha)
    assert.match(outside, /outside the conflict and outside your task:/)
    assert.match(outside, /src\/t2\/y\.ts/)
    assert.match(outside, /stray\.config\.js/)
    assert.ok(merging(alice), 'nothing was committed')
    sh(alice, 'git checkout -- src/t2/y.ts && rm stray.config.js')

    // The acceptance command fails on the resolution. Nothing is committed, the edits stay --
    // and neither force nor a pass claimed for later than the resolution gets past it.
    acceptance('echo "greeting test: expected both names" >&2; exit 3')
    const failed = await done(ha)
    assert.match(failed, /FAILED \(exit 3\) on the resolution, so it was not committed/)
    assert.match(failed, /expected both names/)
    t1.lastTest = { passed: true, ranAt: Date.now() + 1e9, command: 'true', exitCode: 0, summary: 'forged' }
    assert.match(await done(ha, { force: true }), /FAILED \(exit 3\)/)
    assert.ok(merging(alice))
    assert.equal(head(alice), original, 'no resolution commit exists')
    assert.equal(readFileSync(join(alice, 'src/app.ts'), 'utf8'), resolved, 'the resolution is still there')
    assert.equal(sh(alice, 'git rev-parse origin/ss/sx/contract'), contractBefore)
    assert.ok(sent.some((c) => c.type === 'task.testResult' && !c.result.passed && c.result.exitCode === 3))
    assert.ok(!sent.some((c) => c.type === 'task.merged'))

    // It passes: ss_done commits exactly the tree that ran, as the merge, and lands it in the same call.
    acceptance('exit 0')
    const tested = sh(alice, 'git write-tree')
    const landed = await done(ha)
    assert.match(landed, /t1 is merged into ss\/sx\/contract/)
    assert.match(landed, /tested here: `sh ".*acceptance\.sh"` passed on exactly that commit/)
    assert.equal(merging(alice), false)
    const resolution = sh(alice, 'git rev-parse ss/sx/t1')
    assert.equal(sh(alice, `git rev-list --parents -n 1 ${resolution}`).split(' ').length, 3, 'a real merge commit')
    assert.equal(sh(alice, `git rev-parse ${resolution}^{tree}`), tested, 'of exactly the tree that was tested')
    assert.ok(sent.some((c) => c.type === 'task.testResult' && c.result.passed))
    sh(alice, 'git fetch -q origin')
    assert.equal(sh(alice, 'git show origin/ss/sx/contract:src/app.ts'), resolved.trim())
    assert.equal(sh(alice, 'git show origin/ss/sx/contract:src/t2/y.ts'), 'bob', "bob's work survived")
    assert.equal(sh(alice, 'git show origin/ss/sx/contract:src/t1/x.ts'), 'alice', "and so did alice's")
    sh(alice, `git merge-base --is-ancestor ${resolution} origin/ss/sx/contract`)
    assert.ok(sent.some((c) => c.type === 'task.merged' && c.taskId === 't1'))
    assert.equal(sh(alice, 'git for-each-ref refs/session-share'), '', 'the backup goes once the work has landed')
  })

  it('certifies nothing and commits nothing when the passing command changed the tree or HEAD', async () => {
    const { alice, ha, acceptance } = await collision('meddling-test')
    sh(alice, 'git fetch -q origin')
    const contractBefore = sh(alice, 'git rev-parse origin/ss/sx/contract')
    await done(ha)
    const original = head(alice)
    write(alice, 'src/app.ts', resolved)

    // Exits 0, having rewritten a tracked file it was meant to be testing.
    acceptance('echo generated >> src/t1/x.ts')
    const rewrote = await done(ha)
    assert.match(rewrote, /changed what it was testing while it ran/)
    assert.match(rewrote, /files that would be committed changed/)
    assert.equal(head(alice), original, 'nothing committed')
    assert.ok(merging(alice))
    assert.ok(sent.some((c) => c.type === 'task.testResult' && !c.result.passed), 'and not reported as a pass')
    sh(alice, 'git checkout -- src/t1/x.ts')

    // Exits 0, having committed the merge itself: HEAD is not what ran.
    acceptance('git add -A && git commit -qm sneaky')
    assert.match(await done(ha), /HEAD moved from/)
    const sneaky = head(alice)
    assert.notEqual(sneaky, original)
    assert.equal(sh(alice, 'git log -1 --format=%s'), 'sneaky', 'the only new commit is the one the command made')
    // The record no longer matches the checkout, so it stops instead of landing that commit.
    acceptance('exit 0')
    assert.match(await done(ha), /stopped for a person: ss\/sx\/t1 moved to/)
    assert.equal(head(alice), sneaky)
    sh(alice, 'git fetch -q origin')
    assert.equal(sh(alice, 'git rev-parse origin/ss/sx/contract'), contractBefore)
    assert.ok(!sent.some((c) => c.type === 'task.merged'))
  })

  it('stops after repeated failures without undoing the merge or losing an edit, and stays stopped until a person speaks', async () => {
    const { alice, ha, state, acceptance } = await collision('escalate')
    await done(ha)
    const original = head(alice)
    write(alice, 'src/app.ts', resolved)
    acceptance('exit 1')

    let answer
    for (let i = 0; i < 5; i++) answer = await done(ha)
    assert.match(answer, /stopped for a person: it still did not pass after 5 attempts/)
    assert.match(answer, /do not ask to resume it/)
    // Stopped, not undone: the merge and the edit are where they were, and copied under a ref.
    assert.ok(merging(alice))
    assert.equal(head(alice), original)
    assert.equal(readFileSync(join(alice, 'src/app.ts'), 'utf8'), resolved)
    assert.equal(sh(alice, 'git show refs/session-share/sx/t1/attempt-1:src/app.ts'), resolved.trim())
    const told = sent.find((c) => c.type === 'chat.post')
    assert.match(told.body, /needs a person/)
    assert.equal(told.taskRef, 't1')
    assert.ok(!sent.some((c) => c.type === 'task.merged'))

    // Stopped is stopped: calling again, or retrying, does not run anything or reset a count.
    acceptance('exit 0')
    const runs = () => sent.filter((c) => c.type === 'task.testResult').length
    const ran = runs()
    assert.match(await done(ha), /stopped for a person/)
    assert.match(await done(ha, { integration: 'retry' }), /Not resumed/)
    state.chat = [human('take both', { authorKind: 'agent' }), human('take both', { createdAt: 1 })]
    assert.match(await done(ha, { integration: 'retry' }), /Not resumed/, "an agent's message, or one from before it stopped, is not a person deciding")
    assert.match(await done(ha, { integration: 'abort' }), /stopped for a person/)
    assert.equal(runs(), ran)
    assert.ok(merging(alice))

    // A person says how in the room: it resumes the same merge, tests it, and lands it.
    state.chat.push(human('#t1: keep both greetings, as in src/app.ts now'))
    assert.match(await done(ha, { integration: 'retry' }), /t1 is merged into ss\/sx\/contract/)
    sh(alice, 'git fetch -q origin')
    assert.equal(sh(alice, 'git show origin/ss/sx/contract:src/app.ts'), resolved.trim())
  })

  it('keeps the resolution edits, and anyone else\'s made since, before undoing the merge on abort', async () => {
    const { alice, ha } = await collision('abandon')
    await done(ha)
    const original = head(alice)
    write(alice, 'src/app.ts', 'export const greeting = "hello, alice and b')
    // Someone else in the same checkout, after recovery began.
    write(alice, 'README', 'edited while integrating\n')
    write(alice, 'notes/todo.md', 'untracked, theirs\n')

    const answer = await done(ha, { integration: 'abort' })
    assert.match(answer, /stopped for a person: the agent could not resolve the conflict safely/)
    assert.match(answer, /kept at refs\/session-share\/sx\/t1\/attempt-1/)
    assert.equal(merging(alice), false, 'the merge is undone')
    assert.equal(head(alice), original)
    const kept = 'refs/session-share/sx/t1/attempt-1'
    assert.equal(sh(alice, `git show ${kept}:src/app.ts`), 'export const greeting = "hello, alice and b')
    assert.equal(sh(alice, `git show ${kept}:README`), 'edited while integrating')
    assert.equal(sh(alice, `git show ${kept}:notes/todo.md`), 'untracked, theirs')
    // What the merge did not touch is not touched by undoing it either.
    assert.equal(readFileSync(join(alice, 'README'), 'utf8'), 'edited while integrating\n')
    assert.equal(readFileSync(join(alice, 'notes/todo.md'), 'utf8'), 'untracked, theirs\n')
    assert.match(sent.find((c) => c.type === 'chat.post').body, /could not resolve the conflict safely/)
    assert.ok(!sent.some((c) => c.type === 'task.merged'))
  })

  it('stops, rather than landing, when the merge was taken apart by hand', async () => {
    const { alice, ha } = await collision('by-hand')
    await done(ha)
    sh(alice, 'git merge --abort')
    write(alice, 'src/t1/x.ts', 'something else\n')
    sh(alice, 'git commit -qam other')

    assert.match(await done(ha), /stopped for a person: ss\/sx\/t1 moved to .* while its merge was being resolved/)
    assert.match(await done(ha, { force: true }), /stopped for a person/)
    assert.ok(!sent.some((c) => c.type === 'task.merged'))
  })

  it('does not reset its bounds when the contract keeps moving under each tested resolution', async () => {
    const { alice, bob, ha, state } = await collision('moving')
    const moveContract = (n) =>
      sh(
        bob,
        `git fetch -q origin && git checkout -q -B ss/sx/contract origin/ss/sx/contract && printf 'export const greeting = "bob v${n}"\\n' > src/app.ts && git commit -qam bob${n} && git push -q origin ss/sx/contract`,
      )
    assert.match(await done(ha), /Round 1 of 3/)
    for (const n of [2, 3]) {
      write(alice, 'src/app.ts', `export const greeting = "alice and bob, round ${n - 1}"\n`)
      moveContract(n)
      // Tested and committed on the task branch, then the contract has moved again: a new round, counted on.
      assert.match(await done(ha), new RegExp(`Round ${n} of 3`))
      assert.ok(merging(alice))
    }
    write(alice, 'src/app.ts', 'export const greeting = "alice and bob, round 3"\n')
    moveContract(4)
    assert.match(await done(ha), /stopped for a person: ss\/sx\/contract has moved under it 3 times running/)
    assert.match(await done(ha, { integration: 'retry' }), /Not resumed/)
    assert.match(await done(ha, { integration: 'abort' }), /stopped for a person/)
    assert.ok(!sent.some((c) => c.type === 'task.merged'))
    // Every resolution commit on the branch is one that passed: each has a matching passing report.
    const merges = sh(alice, 'git rev-list --first-parent --merges refs/session-share/sx/t1/original..ss/sx/t1').split('\n').filter(Boolean)
    assert.equal(merges.length, 3)
    assert.equal(sent.filter((c) => c.type === 'task.testResult' && c.result.passed).length, 3)
    assert.ok(state)
  })

  /** A pre-push hook that lands Bob's commit on the contract in the instant before Alice's push. */
  function raceOnPush(dir, alice, bob, path, contents) {
    const mark = join(dir, 'raced')
    const hook = join(alice, '.git', 'hooks', 'pre-push')
    writeFileSync(
      hook,
      [
        '#!/bin/sh',
        'grep -q contract || exit 0',
        `[ -f "${mark}" ] && exit 0`,
        `touch "${mark}"`,
        'unset $(git rev-parse --local-env-vars)',
        `cd "${bob}" && git fetch -q origin && git checkout -q -B race origin/ss/sx/contract`,
        `mkdir -p "$(dirname ${path})" && printf '${contents}' > ${path}`,
        'git add -A && git commit -qm race && git push -q origin race:ss/sx/contract',
      ].join('\n'),
    )
    chmodSync(hook, 0o755)
  }

  it('merges in what landed while it was pushing, instead of stranding the task', async () => {
    const { dir, clone } = fresh('push-race')
    const alice = clone('a')
    const ha = tools(alice, snapshot())
    await ha.ss_land_contract({})
    const bob = clone('b')
    await ha.ss_start_task({ taskId: 't1' })
    write(alice, 'src/t1/x.ts', 'alice\n')
    raceOnPush(dir, alice, bob, 'src/t2/y.ts', 'bob\\n')

    assert.match(await done(ha), /t1 is merged into ss\/sx\/contract/)
    sh(alice, 'git fetch -q origin')
    const landed = sh(alice, 'git ls-tree -r --name-only origin/ss/sx/contract')
    assert.match(landed, /src\/t1\/x\.ts/)
    assert.match(landed, /src\/t2\/y\.ts/)
  })

  it('backs out of a merge it could not publish and resolves against what origin has', async () => {
    const { dir, clone } = fresh('push-race-conflict')
    const alice = clone('a')
    const ha = tools(alice, snapshot({ tasks: [task({ lastTest: { passed: true, ranAt: 1 } })] }))
    await ha.ss_land_contract({})
    const bob = clone('b')
    const contractBefore = sh(alice, 'git rev-parse ss/sx/contract')
    await ha.ss_start_task({ taskId: 't1' })
    write(alice, 'src/t1/x.ts', 'alice\n')
    raceOnPush(dir, alice, bob, 'src/t1/x.ts', 'bob got here first\\n')
    sent.length = 0

    const answer = await done(ha)
    assert.match(answer, /conflicts with what has landed/)
    assert.equal(sh(alice, 'git rev-parse ss/sx/contract'), contractBefore, 'the local contract is back where it was')
    const unpublished = sh(alice, 'git rev-parse refs/session-share/sx/t1/unpublished')
    assert.equal(sh(alice, `git show ${unpublished}:src/t1/x.ts`), 'alice', 'and the merge it made is kept')
    assert.equal(sh(alice, 'git branch --show-current'), 'ss/sx/t1')
    assert.equal(sh(alice, 'git rev-parse MERGE_HEAD'), sh(alice, 'git rev-parse origin/ss/sx/contract'), 'resolving against origin')
    assert.ok(!sent.some((c) => c.type === 'task.merged'))
  })

  it('never commits an owned edit made after the run passed, and tests it before it lands', async () => {
    const { alice, ha } = await collision('late-edit')
    sh(alice, 'git fetch -q origin')
    const contractBefore = sh(alice, 'git rev-parse origin/ss/sx/contract')
    await done(ha)
    const original = head(alice)
    write(alice, 'src/app.ts', resolved)
    const tested = sh(alice, 'git add src/app.ts && git write-tree')
    // The task's own file changes while ss_done waits on the server to hear the pass.
    onCommand = (c) => {
      if (c.type === 'task.testResult' && c.result.passed) write(alice, 'src/t1/x.ts', 'late edit\n')
    }
    let answer
    try {
      answer = await done(ha, { commits: [{ message: 'feat(t1): late', paths: ['src/t1/x.ts'] }] })
    } finally {
      onCommand = null
    }
    assert.match(answer, /Files changed after .* passed on/)
    assert.match(answer, /Nothing was committed/)
    // The one new commit is the tested merge; the late edit is beside it, uncommitted.
    assert.equal(sh(alice, 'git rev-parse HEAD^1'), original)
    assert.equal(sh(alice, 'git rev-parse HEAD^{tree}'), tested)
    assert.equal(sh(alice, 'git status --porcelain -- src'), 'M src/t1/x.ts')
    assert.equal(readFileSync(join(alice, 'src/t1/x.ts'), 'utf8'), 'late edit\n')
    sh(alice, 'git fetch -q origin')
    assert.equal(sh(alice, 'git rev-parse origin/ss/sx/contract'), contractBefore, 'nothing landed')
    assert.ok(!sent.some((c) => c.type === 'task.merged'))

    // Called again, the edit is run first, and only then committed and landed.
    const runs = sent.filter((c) => c.type === 'task.testResult' && c.result.passed).length
    assert.match(await done(ha), /t1 is merged into ss\/sx\/contract/)
    assert.equal(sent.filter((c) => c.type === 'task.testResult' && c.result.passed).length, runs + 1)
    sh(alice, 'git fetch -q origin')
    assert.equal(sh(alice, 'git show origin/ss/sx/contract:src/t1/x.ts'), 'late edit')
  })

  /**
   * Alice's task passes alone but not beside Bob's, which git merges with it
   * cleanly. `landing` decides when Bob's work reaches the contract: before
   * Alice finishes, or in the instant she pushes the contract.
   */
  async function cleanButBroken(name, landing) {
    const { dir, clone } = fresh(name)
    const alice = clone('a')
    const script = join(dir, 'acceptance.sh')
    writeFileSync(script, 'test ! -f src/t2/y.ts\n')
    const state = snapshot({
      tasks: [
        task({ lastTest: { passed: true, ranAt: 1 }, acceptance: { testCommand: `sh "${script}"` } }),
        task({ id: 't2', ownedPaths: ['src/t2/**'] }),
      ],
    })
    const ha = tools(alice, () => state)
    await ha.ss_land_contract({})
    const bob = clone('b')
    const contractStart = sh(alice, 'git rev-parse ss/sx/contract')
    await ha.ss_start_task({ taskId: 't1' })
    write(alice, 'src/t1/x.ts', 'alice\n')
    if (landing === 'first') {
      const hb = tools(bob, () => state)
      await hb.ss_start_task({ taskId: 't2' })
      write(bob, 'src/t2/y.ts', 'bob\n')
      assert.match(await hb.ss_done({ taskId: 't2', summary: 's', force: false }), /merged/)
    } else {
      raceOnPush(dir, alice, bob, 'src/t2/y.ts', 'bob\\n')
    }
    sent.length = 0
    const answer = await done(ha)
    return { alice, ha, script, contractStart, answer }
  }

  for (const landing of ['first', 'while pushing']) {
    it(`tests a clean merge with what landed ${landing}, and lands nothing when it fails`, async () => {
      const { alice, ha, script, contractStart, answer } = await cleanButBroken(`clean-broken-${landing.replace(' ', '-')}`, landing)
      assert.match(answer, /FAILED \(exit 1\)/)
      sh(alice, 'git fetch -q origin')
      const upstream = sh(alice, 'git rev-parse origin/ss/sx/contract')
      assert.notEqual(upstream, contractStart, "bob's work did land")
      assert.throws(() => sh(alice, 'git cat-file -e origin/ss/sx/contract:src/t1/x.ts'), 'and nothing of alice published with it')
      // Alice's own commit is there and pushed; the merge with the contract is in progress, not committed.
      const work = sh(alice, 'git rev-parse refs/session-share/sx/t1/original')
      assert.equal(head(alice), work)
      assert.equal(sh(alice, `git rev-parse ${work}^`), contractStart)
      assert.equal(sh(alice, 'git rev-parse origin/ss/sx/t1'), work)
      assert.equal(sh(alice, 'git show HEAD:src/t1/x.ts'), 'alice')
      assert.ok(merging(alice))
      assert.equal(sh(alice, 'git rev-parse MERGE_HEAD'), upstream)
      assert.equal(sh(alice, 'git rev-list --count ss/sx/contract..ss/sx/t1'), '1', 'no integration commit exists')
      if (landing === 'first') assert.equal(sh(alice, 'git rev-parse ss/sx/contract'), upstream)
      else {
        assert.equal(sh(alice, 'git rev-parse ss/sx/contract'), contractStart, 'the local contract is back where it was')
        assert.equal(sh(alice, 'git show refs/session-share/sx/t1/unpublished:src/t1/x.ts'), 'alice', 'and the merge it made is kept')
      }
      assert.ok(!sent.some((c) => c.type === 'task.merged'))

      // Once alice's side copes with bob's, the same merge is tested again and lands.
      writeFileSync(script, 'test -f src/t1/x.ts\n')
      assert.match(await done(ha), /t1 is merged into ss\/sx\/contract/)
      sh(alice, 'git fetch -q origin')
      const landed = sh(alice, 'git ls-tree -r --name-only origin/ss/sx/contract')
      assert.match(landed, /src\/t1\/x\.ts/)
      assert.match(landed, /src\/t2\/y\.ts/)
      const resolution = sh(alice, 'git rev-parse ss/sx/t1')
      assert.equal(sh(alice, `git rev-list --parents -n 1 ${resolution}`).split(' ').length, 3)
      sh(alice, `git merge-base --is-ancestor ${resolution} origin/ss/sx/contract`)
    })
  }
})

describe('shipping only what was run', () => {
  before(() => tools(root, snapshot()).ss_settings({ openPullRequests: false }))
  after(() => tools(root, snapshot()).ss_settings({ openPullRequests: true }))

  /** A session with one task landed, and one more commit on the contract not pushed yet. */
  async function assembled(name) {
    const { clone } = fresh(name)
    const work = clone('a')
    const h = tools(work, snapshot())
    await h.ss_land_contract({})
    await h.ss_start_task({ taskId: 't1' })
    write(work, 'src/t1/x.ts')
    await h.ss_done({ taskId: 't1', summary: 's', force: false })
    write(work, 'docs/notes.md', 'local only\n')
    sh(work, 'git add . && git commit -qm notes')
    return { work, head: sh(work, 'git rev-parse ss/sx/contract'), pushed: sh(work, 'git rev-parse origin/ss/sx/contract') }
  }
  const run = (over = {}) => ({ passed: true, how: 'playwright', summary: 'ok', broke: [], by: 'me', at: 1, commitSha: null, stale: false, ...over })
  const ticketed = (verification, over = {}) =>
    snapshot({
      tasks: [task({ state: 'merged', ticketId: 'k1' })],
      tickets: [{ id: 'k1', title: 'Pay', state: 'review', verification, needsHuman: false, humanCheck: null, mergedAt: null, prNumber: null, ...over }],
    })

  it('refuses a clean merge whose assembled run failed, and pushes nothing', async () => {
    const { work, head, pushed } = await assembled('ship-failed')
    const answer = await tools(work, ticketed(run({ passed: false, commitSha: head }), { state: 'verify' })).ss_ship({})
    assert.match(answer, /Not shipped/)
    assert.match(answer, /"Pay" -- its last run failed/)
    sh(work, 'git fetch -q origin')
    assert.equal(sh(work, 'git rev-parse origin/ss/sx/contract'), pushed)
  })

  it('refuses a pass that is stale, unbound, or of another commit', async () => {
    const { work, head } = await assembled('ship-stale')
    const ship = (verification) => tools(work, ticketed(verification)).ss_ship({})
    assert.match(await ship(run()), /from before runs named the commit/)
    assert.match(await ship(run({ commitSha: head, stale: true })), /changed after it passed/)
    assert.match(await ship(run({ commitSha: 'f'.repeat(40) })), /passed at fffffff, not at this commit/)
    assert.match(await ship(null), /never run assembled/)
    assert.match(
      await tools(work, ticketed(run({ commitSha: head }), { needsHuman: true, state: 'verify' })).ss_ship({}),
      /waiting for a person to look/,
    )
  })

  it('ships when every ticket on the branch passed a run of exactly its head', async () => {
    const { work, head } = await assembled('ship-ok')
    const answer = await tools(work, ticketed(run({ commitSha: head }))).ss_ship({})
    assert.doesNotMatch(answer, /Not shipped/)
    assert.match(answer, /Everything is merged into ss\/sx\/contract/)
    sh(work, 'git fetch -q origin')
    assert.equal(sh(work, 'git rev-parse origin/ss/sx/contract'), head)
  })

  it('ships nothing no ticket vouches for: a session from before tickets, or a task outside one', async () => {
    const { work, head, pushed } = await assembled('ship-legacy')
    const legacy = await tools(work, snapshot({ tasks: [task({ state: 'merged' })], tickets: undefined })).ss_ship({})
    assert.match(legacy, /Not shipped/)
    assert.match(legacy, /t1 -- in no ticket/)

    // A verified ticket does not carry a task that is not in it, nor one naming a ticket that is gone.
    for (const stray of [task({ id: 't2', state: 'merged' }), task({ id: 't2', state: 'merged', ticketId: 'gone' })]) {
      const state = ticketed(run({ commitSha: head }))
      state.tasks.push(stray)
      const answer = await tools(work, state).ss_ship({})
      assert.match(answer, /Not shipped/)
      assert.match(answer, /t2 -- in no ticket/)
      assert.doesNotMatch(answer, /"Pay"/, 'the verified ticket is not the problem')
    }

    // No tasks and no tickets: still nothing that ran, so nothing ships.
    assert.match(await tools(work, snapshot({ tasks: [], tickets: [] })).ss_ship({}), /Not shipped[\s\S]*nothing in it belongs to a ticket/)
    sh(work, 'git fetch -q origin')
    assert.equal(sh(work, 'git rev-parse origin/ss/sx/contract'), pushed, 'nothing was pushed')
  })

  it('names the commit a run is about only when this checkout is that commit, as committed and current', async () => {
    const { dir, clone } = fresh('assembled-commit')
    const work = clone('a')
    const h = tools(work, snapshot())
    await h.ss_land_contract({})
    await h.ss_start_task({ taskId: 't1' })
    write(work, 'src/t1/x.ts')
    sh(work, 'git add . && git commit -qm wip')
    assert.match((await assembledCommit(work, 'sx')).problem, /not at ss\/sx\/contract/)

    sh(work, 'git checkout -q ss/sx/contract')
    assert.deepEqual(await assembledCommit(work, 'sx'), { sha: sh(work, 'git rev-parse HEAD') })

    write(work, 'src/contract.ts', 'export const changed = 1\n')
    assert.match((await assembledCommit(work, 'sx')).problem, /not as ss\/sx\/contract has them[\s\S]*src\/contract\.ts/)
    sh(work, 'git checkout -- src/contract.ts')

    // An untracked source or config file is part of what ran; ignored build output is not.
    sh(work, "printf 'dist/\\n' > .gitignore && git add .gitignore && git commit -qm ignore")
    write(work, 'src/extra.config.ts', 'export default { flag: true }\n')
    assert.match((await assembledCommit(work, 'sx')).problem, /src\/extra\.config\.ts/)
    rmSync(join(work, 'src/extra.config.ts'))
    write(work, 'dist/bundle.js', 'built\n')
    assert.deepEqual(await assembledCommit(work, 'sx'), { sha: sh(work, 'git rev-parse HEAD') })
    sh(work, 'git push -q origin ss/sx/contract')

    const other = clone('b')
    sh(other, 'git checkout -q ss/sx/contract && echo more > more.txt && git add . && git commit -qm more && git push -q')
    assert.match((await assembledCommit(work, 'sx')).problem, /origin\/ss\/sx\/contract has commits this checkout does not/)
    assert.ok(dir)
  })

  it('records a failure without asking origin anything, and refuses a pass it cannot pin', async () => {
    const { clone } = fresh('verdict-offline')
    const work = clone('a')
    const h = tools(work, snapshot())
    await h.ss_land_contract({})
    sh(work, 'git checkout -q ss/sx/contract')
    write(work, 'src/wip.ts', 'half done\n')
    sh(work, `git remote set-url origin ${join(root, 'nowhere.git')}`)

    assert.deepEqual(await verdictCommit(work, 'sx', false), { sha: null }, 'dirty and offline, and still reportable')
    assert.match((await verdictCommit(work, 'sx', true)).problem, /src\/wip\.ts/)
    rmSync(join(work, 'src/wip.ts'))
    assert.match((await verdictCommit(work, 'sx', true)).problem, /Could not tell which commit ran/, 'a pass needs origin')
  })

  it('opens the final pull request ready for review, and takes an early draft out of draft', async () => {
    const { work, head } = await assembled('ship-pr')
    const bin = join(root, 'fake-gh')
    mkdirSync(bin, { recursive: true })
    const log = join(bin, 'calls.log')
    const list = join(bin, 'list.json')
    writeFileSync(
      join(bin, 'gh'),
      [
        '#!/bin/sh',
        `echo "$*" >> "${log}"`,
        'case "$1 $2" in',
        `  "pr list") cat "${list}" ;;`,
        '  "pr create") echo "https://github.com/o/r/pull/42" ;;',
        '  "pr ready") exit 0 ;;',
        '  *) exit 1 ;;',
        'esac',
      ].join('\n'),
    )
    chmodSync(join(bin, 'gh'), 0o755)
    const path = process.env.PATH
    process.env.PATH = `${bin}:${path}`
    await tools(root, snapshot()).ss_settings({ openPullRequests: true })
    try {
      const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [])
      const ship = (verification) => tools(work, ticketed(verification)).ss_ship({})

      // Not shippable: GitHub is never asked to do anything -- a legacy session with no tickets included.
      writeFileSync(list, '[{"number":7,"isDraft":true}]')
      assert.match(await ship(run({ commitSha: 'f'.repeat(40) })), /Not shipped/)
      assert.match(await tools(work, snapshot({ tasks: [task({ state: 'merged' })], tickets: undefined })).ss_ship({}), /Not shipped/)
      assert.deepEqual(calls(), [])

      // The draft PR landing the contract opened is made ready, at the head that passed.
      const readied = await ship(run({ commitSha: head }))
      assert.match(readied, new RegExp(`PR #7: .* at ${head.slice(0, 7)}`))
      assert.match(readied, /now ready for review/)
      assert.ok(calls().includes('pr ready 7'))
      assert.ok(!calls().some((call) => call.startsWith('pr create')))

      // None open yet: one is opened, not as a draft.
      writeFileSync(list, '[]')
      rmSync(log)
      assert.match(await ship(run({ commitSha: head })), /PR #42/)
      const created = calls().find((call) => call.startsWith('pr create'))
      assert.ok(created)
      assert.doesNotMatch(created, /--draft/)
      assert.match(created, /--head ss\/sx\/contract --base main/)
    } finally {
      process.env.PATH = path
      await tools(root, snapshot()).ss_settings({ openPullRequests: false })
    }
  })
})

describe('starting a merge for someone to test', () => {
  it('stages a clean merge without committing it', async () => {
    const { clone } = fresh('clean-begin', { remote: false })
    const work = clone('a')
    sh(work, 'git checkout -q -b other && echo b > b.txt && git add . && git commit -qm b && git checkout -q main')
    sh(work, 'echo a > a.txt && git add . && git commit -qm a')
    const before = sh(work, 'git rev-parse HEAD')
    assert.deepEqual(await beginMerge(work, 'other'), { merged: true, conflicts: [] })
    assert.equal(sh(work, 'git rev-parse HEAD'), before, 'nothing committed')
    assert.equal(sh(work, 'git rev-parse MERGE_HEAD'), sh(work, 'git rev-parse other'))
    assert.match(sh(work, 'git diff --cached --name-only'), /b\.txt/)
  })

  it('reports git grep failing instead of taking it for no markers', async () => {
    const { clone } = fresh('grep-fails', { remote: false })
    const work = clone('a')
    write(work, 'c.txt', '<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> other\n')
    assert.deepEqual(await conflictMarkers(work, ['c.txt']), ['c.txt:1:<<<<<<< HEAD', 'c.txt:5:>>>>>>> other'])
    write(work, 'c.txt', 'clean\n')
    assert.deepEqual(await conflictMarkers(work, ['c.txt']), [])
    // A path git grep cannot read: an error, not an all-clear.
    mkdirSync(join(work, 'locked'))
    write(work, 'locked/f.txt', '<<<<<<< x\n')
    chmodSync(join(work, 'locked/f.txt'), 0o000)
    try {
      await assert.rejects(conflictMarkers(work, ['locked/f.txt']), /git grep failed/)
    } finally {
      chmodSync(join(work, 'locked/f.txt'), 0o644)
    }
  })
})
