import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { EventEnvelope } from '@session-share/protocol'
import { readConfig, type SessionConfig } from './config.js'
import { HOST_HEADER, hostKey } from './daemon.js'
import { fetchLog, listMirrored, pushLog, readMirrored, type MirrorMeta, type PushResult } from './mirror.js'
import { readPreferences } from './preferences.js'

const MIRROR_MS = Number(process.env.SESSION_SHARE_MIRROR_MS ?? 2 * 60_000)

const logFile = () => join(process.env.SESSION_SHARE_HOME ?? join(homedir(), '.session-share'), 'mirror.log')

function log(line: string): void {
  try {
    mkdirSync(join(logFile(), '..'), { recursive: true })
    appendFileSync(logFile(), `${new Date().toISOString()} ${line}\n`)
  } catch {
    // Never worth failing over.
  }
}

async function readEvents(
  config: SessionConfig,
  from: number,
  limit: number,
): Promise<{ events: EventEnvelope[]; maxSeq: number }> {
  const url = new URL(`/sessions/${config.sessionRef}/events`, config.serverUrl)
  url.searchParams.set('from', String(from))
  url.searchParams.set('limit', String(limit))
  const response = await fetch(url, {
    headers: config.participantToken ? { authorization: `Bearer ${config.participantToken}` } : {},
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`the server answered ${response.status}`)
  return (await response.json()) as { events: EventEnvelope[]; maxSeq: number }
}

/** Copies whatever the branch is missing from this checkout's session. */
export async function mirrorOnce(config: SessionConfig): Promise<PushResult> {
  const first = await readEvents(config, 0, 1)
  const created = first.events[0]?.body
  if (!created || created.type !== 'session.created') {
    return { pushed: false, reason: 'the session has no log yet' }
  }
  const session = created.session
  return pushLog(config.repoPath, {
    meta: {
      sessionId: session.id,
      slug: session.slug,
      title: session.title,
      repo: session.repo.owner === 'local' ? null : { owner: session.repo.owner, name: session.repo.name },
    },
    maxSeq: first.maxSeq,
    read: async (from, to) => {
      const events: EventEnvelope[] = []
      let next = from
      while (next <= to) {
        const page = await readEvents(config, next, Math.min(5000, to - next + 1))
        if (page.events.length === 0) break
        events.push(...page.events.filter((event) => event.seq <= to))
        next = page.events.at(-1)!.seq + 1
      }
      return events
    },
  })
}

let running = false

/**
 * Keeps the repository's copy of the log current while this Claude Code is
 * open. Every attached checkout does this, not only the host's: whichever
 * machine is still around when another one disappears holds the newest copy.
 */
export function startMirror(): () => void {
  const env = process.env.SESSION_SHARE_MIRROR
  if (env === 'off' || process.env.SESSION_SHARE_AUTOPILOT === 'child') return () => undefined

  const tick = async () => {
    if (running || !readPreferences().mirror) return
    const config = readConfig(process.env.SESSION_SHARE_REPO ?? process.cwd())
    if (!config) return
    running = true
    try {
      const result = await mirrorOnce(config)
      if (result.pushed) log(`pushed ${config.sessionRef} up to event ${result.upToSeq}`)
    } catch (error) {
      log(`mirror failed: ${error instanceof Error ? error.message : error}`)
    } finally {
      running = false
    }
  }
  const timer = setInterval(() => void tick(), MIRROR_MS)
  timer.unref?.()
  // Once soon after start, so a fresh session is on the branch before anyone needs it.
  const first = setTimeout(() => void tick(), 15_000)
  first.unref?.()
  return () => {
    clearInterval(timer)
    clearTimeout(first)
  }
}

export interface Restored {
  sessionId: string
  slug: string
  invite: string | null
  added: number
  upToSeq: number
  updatedAt: number
}

async function importInto(
  serverUrl: string,
  meta: MirrorMeta,
  events: Awaited<ReturnType<typeof readMirrored>>,
): Promise<Restored> {
  const response = await fetch(new URL('/api/sessions/import', serverUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json', [HOST_HEADER]: hostKey() },
    body: JSON.stringify({ sessionId: meta.sessionId, slug: meta.slug, events }),
  })
  const payload = (await response.json()) as {
    invite?: string | null
    added?: number
    upToSeq?: number
    message?: string
    error?: string
  }
  if (!response.ok) throw new Error(payload.message ?? payload.error ?? `import failed (${response.status})`)
  return {
    sessionId: meta.sessionId,
    slug: meta.slug,
    invite: payload.invite ?? null,
    added: payload.added ?? 0,
    upToSeq: payload.upToSeq ?? -1,
    updatedAt: meta.updatedAt,
  }
}

/**
 * Puts this repository's session back on the local server from the branch:
 * the one named `slug` when given, else the most recently active one for this
 * repository. Null when the branch has nothing for it.
 */
export async function restoreFromMirror(
  root: string,
  serverUrl: string,
  repo: { owner: string; name: string } | null,
  slug: string | null,
): Promise<Restored | null> {
  if (!(await fetchLog(root))) return null
  const candidates = (await listMirrored(root))
    .filter((meta) => !repo || !meta.repo || (meta.repo.owner === repo.owner && meta.repo.name === repo.name))
    .filter((meta) => !slug || meta.slug === slug)
    .sort((a, b) => b.updatedAt - a.updatedAt)
  const meta = candidates[0]
  if (!meta) return null
  return importInto(serverUrl, meta, await readMirrored(root, meta.sessionId))
}

/**
 * Brings a session this server already has up to what the branch holds, for a
 * server that was down while another machine hosted. Quietly does nothing
 * when the branch is not ahead, or when the two histories disagree.
 */
export async function catchUpFromMirror(root: string, serverUrl: string, slug: string): Promise<number> {
  try {
    if (!(await fetchLog(root))) return 0
    const meta = (await listMirrored(root)).find((m) => m.slug === slug)
    if (!meta) return 0
    const restored = await importInto(serverUrl, meta, await readMirrored(root, meta.sessionId))
    return restored.added
  } catch (error) {
    log(`catch-up skipped: ${error instanceof Error ? error.message : error}`)
    return 0
  }
}

