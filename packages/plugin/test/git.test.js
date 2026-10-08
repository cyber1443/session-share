import { strict as assert } from 'node:assert'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { registerGitTools } from '../dist/tools-git.js'

/**
 * The git half of finishing a task, against real repositories and a real bare
 * remote. The coordination server is a stub that accepts every command: what
 * is under test here is what happens to people's working trees.
 */
let root
let server
let serverUrl

const sh = (cwd, cmd) => execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'ss-git-'))
  process.env.SESSION_SHARE_HOME = join(root, 'home')
  server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
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

    const merged = snapshot({ tasks: [task({ state: 'merged' }), task({ id: 't2', state: 'merged' })] })
    const shipped = await tools(bob, merged).ss_ship({})
    assert.doesNotMatch(shipped, /rejected|failed/)
    assert.match(shipped, /ss\/sx\/contract/)
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
})
