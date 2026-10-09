import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { LOG_BRANCH, fetchLog, listMirrored, pushLog, readMirrored } from '../dist/mirror.js'

/**
 * The repository as the session's memory: a log pushed from one clone has to
 * read back whole from another, survive two people pushing at once, and never
 * touch anybody's working tree.
 */
const root = mkdtempSync(join(tmpdir(), 'ss-mirror-test-'))
after(() => rmSync(root, { recursive: true, force: true }))

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

function clones() {
  const id = Math.random().toString(36).slice(2, 8)
  const remote = join(root, `remote-${id}.git`)
  git(root, 'init', '--quiet', '--bare', '-b', 'main', remote)
  const seed = join(root, `seed-${id}`)
  git(root, 'init', '--quiet', '-b', 'main', seed)
  git(seed, 'config', 'user.email', 't@example.com')
  git(seed, 'config', 'user.name', 't')
  writeFileSync(join(seed, 'README.md'), 'hi\n')
  git(seed, 'add', '.')
  git(seed, 'commit', '--quiet', '-m', 'init')
  git(seed, 'remote', 'add', 'origin', remote)
  git(seed, 'push', '--quiet', 'origin', 'main')
  const clone = (name) => {
    const dir = join(root, `${name}-${id}`)
    git(root, 'clone', '--quiet', remote, dir)
    return dir
  }
  return { a: clone('a'), b: clone('b') }
}

const SESSION = '6b6b6b6b-1111-4222-8333-444444444444'
const events = (count) =>
  Array.from({ length: count }, (_, seq) => ({
    seq,
    ts: 1_700_000_000_000 + seq,
    actorId: null,
    body:
      seq === 0
        ? { type: 'session.created', session: { id: SESSION, slug: 'todo' } }
        : { type: 'chat.message', message: { body: `m${seq}` } },
  }))

const source = (log) => ({
  meta: { sessionId: SESSION, slug: 'todo', title: 'Todo', repo: { owner: 'acme', name: 'todo' } },
  maxSeq: log.length - 1,
  read: async (from, to) => log.filter((event) => event.seq >= from && event.seq <= to),
})

describe('the log mirror', () => {
  it('pushes a log across chunk boundaries and reads it back whole from another clone', async () => {
    const { a, b } = clones()
    const log = events(2_345)
    const pushed = await pushLog(a, source(log))
    assert.equal(pushed.pushed, true, pushed.reason)
    assert.equal(git(a, 'status', '--porcelain'), '', 'the working tree is never touched')
    assert.equal(git(a, 'branch', '--show-current'), 'main')

    assert.equal(await fetchLog(b), true)
    const [meta] = await listMirrored(b)
    assert.equal(meta.slug, 'todo')
    assert.equal(meta.upToSeq, 2_344)
    const back = await readMirrored(b, SESSION)
    assert.equal(back.length, log.length)
    assert.deepEqual(back.at(-1), log.at(-1))
  })

  it('only ever extends, and takes turns when two clones push at once', async () => {
    const { a, b } = clones()
    const log = events(1_500)
    assert.equal((await pushLog(a, source(log.slice(0, 1_200)))).pushed, true)
    // b is behind the branch: it must not shrink it.
    const stale = await pushLog(b, source(log.slice(0, 900)))
    assert.equal(stale.pushed, false)

    const [first, second] = await Promise.all([pushLog(a, source(log)), pushLog(b, source(log.slice(0, 1_400)))])
    assert.ok(first.pushed || second.pushed)
    await fetchLog(a)
    const back = await readMirrored(a, SESSION)
    assert.equal(back.length, 1_500, 'the longest copy wins, whoever pushed last')
    assert.deepEqual(
      back.map((event) => event.seq),
      log.map((event) => event.seq),
    )
  })

  it('finds nothing in a repository that has never been mirrored', async () => {
    const { a } = clones()
    assert.equal(await fetchLog(a), false)
    assert.deepEqual(await listMirrored(a), [])
    assert.ok(!git(a, 'ls-remote', '--heads', 'origin').includes(LOG_BRANCH))
  })
})
