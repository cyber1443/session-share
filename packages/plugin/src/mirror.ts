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

/**
 * Runs git and settles once it has exited, with its stdout or its last line of
 * stderr.
 *
 * Stdin is only a pipe when there is input to send. A command that reads
 * nothing gets no pipe at all: an empty write to one that git had already
 * closed by exiting failed with EPIPE outside this promise, and took the
 * process with it.
 *
 * When there is input -- only `hash-object --stdin`, a string or a picture's
 * bytes -- a failed write is settled here too. A nonzero exit is reported as
 * git's own error, whatever happened to the write. An exit of 0 after the write
 * failed is refused all the same: hash-object only finishes once it has read to
 * the end, and it cannot see the end until every byte was written, so a write
 * that failed means it hashed something other than what was sent.
 */
function git(
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; input?: string | Uint8Array } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const { input } = options
    const child = spawn('git', args, {
      cwd,
      env: { ...process.env, ...options.env },
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let stdinError: Error | null = null
    let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null
    // The child's 'close' does not wait for its stdin, so settle on whichever of the two finishes last.
    let stdinOpen = Boolean(input !== undefined && child.stdin)
    const settle = () => {
      if (!exit || stdinOpen) return
      const { code, signal } = exit
      if (code !== 0) reject(new Error(`git ${args[0]} failed: ${stderr.trim().split('\n').at(-1) || (signal ?? code)}`))
      else if (stdinError) reject(new Error(`git ${args[0]} exited before reading all of its input: ${stdinError.message}`))
      else resolve(stdout.trim())
    }
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk))
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk))
    child.on('error', reject)
    child.on('close', (code, signal) => {
      exit = { code, signal }
      settle()
    })
    if (input !== undefined && child.stdin) {
      child.stdin.on('error', (error) => (stdinError = error))
      child.stdin.on('close', () => {
        stdinOpen = false
        settle()
      })
      child.stdin.end(typeof input === 'string' ? input : Buffer.from(input))
    }
  })
}

/** A session's mirrored pictures, read back for a restore. */
export async function readMirroredFiles(cwd: string, sessionId: string): Promise<Array<Omit<MirrorFile, 'bytes'> & { base64: string }>> {
  const head = await remoteHead(cwd)
  if (!head) return []
  const index = JSON.parse((await show(cwd, head, `${sessionDir(sessionId)}/files.json`)) ?? '[]') as Array<Omit<MirrorFile, 'bytes'>>
  const files = []
  for (const file of index) {
    const bytes = await new Promise<Buffer>((resolve) => {
      const child = spawn('git', ['cat-file', 'blob', `${head}:${sessionDir(sessionId)}/files/${file.id}`], { cwd })
      const chunks: Buffer[] = []
      child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
      child.on('close', () => resolve(Buffer.concat(chunks)))
      child.on('error', () => resolve(Buffer.alloc(0)))
    })
    if (bytes.length > 0) files.push({ ...file, base64: bytes.toString('base64') })
  }
  return files
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

export interface MirrorFile {
  id: string
  name: string
  type: string
  bytes: Uint8Array
}

export interface PushSource {
  /** The session's pictures; copied once each, since a file never changes. */
  files?: { ids: () => Promise<string[]>; read: (id: string) => Promise<MirrorFile | null> }
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
    const filesPath = `${sessionDir(source.meta.sessionId)}/files.json`
    const knownFiles = new Set(
      ((parent ? JSON.parse((await show(cwd, parent, filesPath)) ?? '[]') : []) as Array<{ id: string }>).map((f) => f.id),
    )
    const newFiles = source.files ? (await source.files.ids()).filter((id) => !knownFiles.has(id)) : []
    if (mirrored >= source.maxSeq && newFiles.length === 0) {
      return { pushed: false, reason: 'the branch is already up to date' }
    }

    const dir = mkdtempSync(join(tmpdir(), 'ss-mirror-'))
    const env = { GIT_INDEX_FILE: join(dir, 'index') }
    try {
      await git(cwd, parent ? ['read-tree', parent] : ['read-tree', '--empty'], { env })

      const write = async (path: string, content: string) => {
        const blob = await git(cwd, ['hash-object', '-w', '--stdin'], { input: content })
        await git(cwd, ['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], { env })
      }

      if (newFiles.length > 0 && source.files) {
        const index = parent ? (JSON.parse((await show(cwd, parent, filesPath)) ?? '[]') as Array<Omit<MirrorFile, 'bytes'>>) : []
        for (const id of newFiles) {
          const file = await source.files.read(id)
          if (!file) continue
          const blob = await git(cwd, ['hash-object', '-w', '--stdin'], { input: file.bytes })
          await git(cwd, ['update-index', '--add', '--cacheinfo', `100644,${blob},${sessionDir(source.meta.sessionId)}/files/${id}`], { env })
          index.push({ id, name: file.name, type: file.type })
        }
        await write(filesPath, `${JSON.stringify(index, null, 2)}\n`)
      }

      // Rewrite from the start of the chunk the branch stopped in.
      const firstChunk = Math.floor((mirrored + 1) / CHUNK)
      const lastChunk = Math.floor(source.maxSeq / CHUNK)
      for (let chunk = mirrored >= source.maxSeq ? lastChunk + 1 : firstChunk; chunk <= lastChunk; chunk++) {
        const from = chunk * CHUNK
        const to = Math.min(source.maxSeq, from + CHUNK - 1)
        const events = await source.read(from, to)
        const lines = events.map((event) =>
          JSON.stringify({ seq: event.seq, ts: event.ts, actorId: event.actorId, body: event.body }),
        )
        await write(`${sessionDir(source.meta.sessionId)}/events/${chunkName(from)}.jsonl`, `${lines.join('\n')}\n`)
      }
      const meta: MirrorMeta = { ...source.meta, upToSeq: Math.max(source.maxSeq, mirrored), updatedAt: Date.now() }
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
