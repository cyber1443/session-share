import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { LOG_BRANCH, fetchLog, listMirrored, pushLog, readMirrored, readMirroredFiles } from '../dist/mirror.js'

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
    // Clones do not inherit the seed's local config, and pushLog commits.
    git(dir, 'config', 'user.email', 't@example.com')
    git(dir, 'config', 'user.name', 't')
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

  it('carries pictures too, byte for byte, and copies each only once', async () => {
    const { a, b } = clones()
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 255])
    let reads = 0
    const withFiles = (log) => ({
      ...source(log),
      files: {
        ids: async () => ['pic1'],
        read: async (id) => {
          reads++
          return { id, name: 'mock.png', type: 'image/png', bytes: png }
        },
      },
    })
    assert.equal((await pushLog(a, withFiles(events(3)))).pushed, true)
    assert.equal((await pushLog(a, withFiles(events(5)))).pushed, true)
    assert.equal(reads, 1, 'a picture already on the branch is not copied again')

    await fetchLog(b)
    const [file] = await readMirroredFiles(b, SESSION)
    assert.equal(file.type, 'image/png')
    assert.deepEqual([...Buffer.from(file.base64, 'base64')], [...png])
    assert.equal((await readMirrored(b, SESSION)).length, 5)
  })

  it('finds nothing in a repository that has never been mirrored', async () => {
    const { a } = clones()
    assert.equal(await fetchLog(a), false)
    assert.deepEqual(await listMirrored(a), [])
    assert.ok(!git(a, 'ls-remote', '--heads', 'origin').includes(LOG_BRANCH))
  })
})

/**
 * Git closing its stdin early. A git that exits before reading -- a failing
 * command, or one that never wanted input -- used to leave the write to its
 * stdin failing with EPIPE outside any promise, which took the whole process
 * down instead of failing the push. A stand-in `git` on PATH makes that
 * happen on purpose, and passes everything else through to the real one.
 */
describe('the log mirror, when git closes its stdin', () => {
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  const bin = join(root, 'fake-git-bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(
    join(bin, 'git'),
    [
      '#!/bin/sh',
      'if [ "$1" = hash-object ]; then',
      '  case "$SS_FAKE_GIT" in',
      '    fail) exec 0<&-; echo "fatal: simulated hash-object failure" >&2; exit 128 ;;',
      '    close) exec 0<&-; echo 0123456789abcdef0123456789abcdef01234567; exit 0 ;;',
      '  esac',
      'elif [ "$SS_FAKE_GIT" = no-stdin ] && [ ! -c /dev/stdin ]; then',
      '  echo "fatal: git $1 was handed a stdin pipe it never reads" >&2; exit 99',
      'fi',
      `exec '${realGit}' "$@"`,
      '',
    ].join('\n'),
  )
  chmodSync(join(bin, 'git'), 0o755)

  const withFakeGit = async (mode, run) => {
    const saved = { PATH: process.env.PATH, SS_FAKE_GIT: process.env.SS_FAKE_GIT }
    process.env.PATH = `${bin}:${saved.PATH}`
    process.env.SS_FAKE_GIT = mode
    try {
      return await run()
    } finally {
      process.env.PATH = saved.PATH
      if (saved.SS_FAKE_GIT === undefined) delete process.env.SS_FAKE_GIT
      else process.env.SS_FAKE_GIT = saved.SS_FAKE_GIT
    }
  }

  // Far more than any pipe or socket buffer holds, so the write cannot finish before git hangs up.
  const big = new Uint8Array(4 * 1024 * 1024).fill(7)
  const withPicture = (log) => ({
    ...source(log),
    files: { ids: async () => ['pic1'], read: async (id) => ({ id, name: 'big.png', type: 'image/png', bytes: big }) },
  })

  it('gives commands that take no input no stdin to close', async () => {
    const { a, b } = clones()
    const pushed = await withFakeGit('no-stdin', () => pushLog(a, source(events(1_200))))
    assert.equal(pushed.pushed, true, pushed.reason)
    assert.equal(await withFakeGit('no-stdin', () => fetchLog(b)), true)
    assert.equal((await withFakeGit('no-stdin', () => readMirrored(b, SESSION))).length, 1_200)
  })

  it('fails the push with git\'s own error when git exits nonzero without reading', async () => {
    const { a } = clones()
    await assert.rejects(
      withFakeGit('fail', () => pushLog(a, withPicture(events(3)))),
      /git hash-object failed: fatal: simulated hash-object failure/,
    )
    assert.ok(!git(a, 'ls-remote', '--heads', 'origin').includes(LOG_BRANCH), 'nothing was pushed')
  })

  it('refuses a hash of input git never read, even when it exits 0', async () => {
    const { a } = clones()
    await assert.rejects(withFakeGit('close', () => pushLog(a, withPicture(events(3)))), /before reading all of its input/)
    assert.ok(!git(a, 'ls-remote', '--heads', 'origin').includes(LOG_BRANCH), 'nothing was pushed')
  })
})
