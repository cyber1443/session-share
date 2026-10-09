import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EventEnvelope } from '@session-share/protocol'

/**
 * The repository as the session's memory.
 *
 * A session's whole state is its event log, and that log used to live in one
 * SQLite file on whichever laptop hosted it. Lose the laptop, or start over on
 * another one, and two years of tickets, splits, history and usage were gone.
 *
 * So the log is mirrored into the project's own GitHub repository, on an
 * orphan branch nobody checks out: `session-share/log`. Every attached checkout
 * pushes what it has seen, so the newest copy survives whichever machine goes
 * away; and hosting on a machine whose server has never heard of the session
 * puts it back from there, ids and all, so seats and tasks come back as they
 * were.
 *
 * Written with git plumbing against a throwaway index: the working tree, the
 * real index and the checked-out branch are never touched.
 */
export const LOG_BRANCH = 'session-share/log'
const REMOTE_REF = `refs/remotes/origin/${LOG_BRANCH}`
/** Events per file. Small enough that a push rewrites little, large enough not to make thousands of files. */
const CHUNK = 1000

export interface MirrorMeta {
  sessionId: string
  slug: string
  title: string
  repo: { owner: string; name: string } | null
  /** The last seq written to the branch. */
  upToSeq: number
  updatedAt: number
}

type StoredEvent = Pick<EventEnvelope, 'seq' | 'ts' | 'actorId' | 'body'>

function git(cwd: string, args: string[], options: { env?: NodeJS.ProcessEnv; input?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim())
      else reject(new Error(`git ${args[0]} failed: ${stderr.trim().split('\n').at(-1) ?? code}`))
    })
    child.stdin.end(options.input ?? '')
  })
}

const chunkName = (seq: number) => String(Math.floor(seq / CHUNK)).padStart(6, '0')
const sessionDir = (sessionId: string) => `sessions/${sessionId}`

/** Fetches the log branch. False when the remote has none yet, or there is no remote. */
export async function fetchLog(cwd: string): Promise<boolean> {
  try {
    await git(cwd, ['fetch', '--quiet', 'origin', `+refs/heads/${LOG_BRANCH}:${REMOTE_REF}`])
    return true
  } catch {
    return false
  }
}

async function remoteHead(cwd: string): Promise<string | null> {
  try {
    return await git(cwd, ['rev-parse', '--verify', '--quiet', `${REMOTE_REF}^{commit}`])
  } catch {
    return null
  }
}

async function show(cwd: string, rev: string, path: string): Promise<string | null> {
  try {
    return await git(cwd, ['show', `${rev}:${path}`])
  } catch {
    return null
  }
}

/** Every session mirrored on the branch, as of the last fetch. */
export async function listMirrored(cwd: string): Promise<MirrorMeta[]> {
  const head = await remoteHead(cwd)
  if (!head) return []
  const names = await git(cwd, ['ls-tree', '--name-only', `${head}:sessions`]).catch(() => '')
  const metas: MirrorMeta[] = []
  for (const name of names.split('\n').filter(Boolean)) {
    const raw = await show(cwd, head, `${sessionDir(name)}/meta.json`)
    if (!raw) continue
    try {
      metas.push(JSON.parse(raw) as MirrorMeta)
    } catch {
      // A hand-edited or half-written meta is skipped, not fatal.
    }
  }
  return metas
}

/** Reads one mirrored session's whole log back, oldest first. */
export async function readMirrored(cwd: string, sessionId: string): Promise<StoredEvent[]> {
  const head = await remoteHead(cwd)
  if (!head) return []
  const files = await git(cwd, ['ls-tree', '--name-only', `${head}:${sessionDir(sessionId)}/events`]).catch(() => '')
  const events: StoredEvent[] = []
  for (const file of files.split('\n').filter(Boolean).sort()) {
    const raw = await show(cwd, head, `${sessionDir(sessionId)}/events/${file}`)
    for (const line of (raw ?? '').split('\n')) {
      if (line.trim()) events.push(JSON.parse(line) as StoredEvent)
    }
  }
  return events.sort((a, b) => a.seq - b.seq)
}

export interface PushSource {
  meta: Omit<MirrorMeta, 'upToSeq' | 'updatedAt'>
  /** The newest seq the server has. */
  maxSeq: number
  /** Events from `from` up to `to`, inclusive, from the server. */
  read: (from: number, to: number) => Promise<StoredEvent[]>
}

export type PushResult =
  | { pushed: true; upToSeq: number; commit: string }
  | { pushed: false; reason: string }

/**
 * Writes whatever the branch is missing and pushes it. Only ever extends: if
 * the branch already has as much as the server, or more, nothing is written.
 * Two people pushing at once write the same bytes for the same seqs, so a
 * rejected push is retried on top of the other one rather than fought over.
 */
export async function pushLog(cwd: string, source: PushSource, attempts = 3): Promise<PushResult> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    await fetchLog(cwd)
    const parent = await remoteHead(cwd)
    const metaPath = `${sessionDir(source.meta.sessionId)}/meta.json`
    const current = parent ? await show(cwd, parent, metaPath) : null
    const mirrored = current ? (JSON.parse(current) as MirrorMeta).upToSeq : -1
    if (mirrored >= source.maxSeq) return { pushed: false, reason: 'the branch is already up to date' }

    const dir = mkdtempSync(join(tmpdir(), 'ss-mirror-'))
    const env = { GIT_INDEX_FILE: join(dir, 'index') }
    try {
      await git(cwd, parent ? ['read-tree', parent] : ['read-tree', '--empty'], { env })

      const write = async (path: string, content: string) => {
        const blob = await git(cwd, ['hash-object', '-w', '--stdin'], { input: content })
        await git(cwd, ['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], { env })
      }

      // Rewrite from the start of the chunk the branch stopped in.
      const firstChunk = Math.floor((mirrored + 1) / CHUNK)
      const lastChunk = Math.floor(source.maxSeq / CHUNK)
      for (let chunk = firstChunk; chunk <= lastChunk; chunk++) {
        const from = chunk * CHUNK
        const to = Math.min(source.maxSeq, from + CHUNK - 1)
        const events = await source.read(from, to)
        const lines = events.map((event) =>
          JSON.stringify({ seq: event.seq, ts: event.ts, actorId: event.actorId, body: event.body }),
        )
        await write(`${sessionDir(source.meta.sessionId)}/events/${chunkName(from)}.jsonl`, `${lines.join('\n')}\n`)
      }
      const meta: MirrorMeta = { ...source.meta, upToSeq: source.maxSeq, updatedAt: Date.now() }
      await write(metaPath, `${JSON.stringify(meta, null, 2)}\n`)
      if (!parent) {
        await write(
          'README.md',
          [
            '# session-share log',
            '',
            'This branch is the memory of the session-share sessions on this repository:',
            'every ticket, split, task, message and usage report, as an append-only event log.',
            'It is written by the plugin and read back by `/ss:host` to restore a session on any',
            'machine. Nothing here is meant to be merged or edited by hand.',
            '',
          ].join('\n'),
        )
      }

      const tree = await git(cwd, ['write-tree'], { env })
      const commit = await git(
        cwd,
        ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', `log: ${source.meta.slug} up to event ${source.maxSeq}`],
      )
      try {
        await git(cwd, ['push', '--quiet', 'origin', `${commit}:refs/heads/${LOG_BRANCH}`])
        return { pushed: true, upToSeq: source.maxSeq, commit }
      } catch (error) {
        // Someone else pushed first. Their copy is a prefix or a superset of ours; go again on top.
        if (attempt === attempts - 1) {
          return { pushed: false, reason: error instanceof Error ? error.message : String(error) }
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  return { pushed: false, reason: 'gave up after repeated push races' }
}
