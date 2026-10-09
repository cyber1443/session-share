import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { EventBody, EventEnvelope, ParticipantId, SessionId } from '@session-share/protocol'
import type { JoinTokenRow, User } from './auth.js'

/**
 * Only two things are persisted: an index of sessions so a slug can be resolved
 * without loading anything, and the append-only event log. Tasks, leases, chat
 * and the merge queue are projections -- they are folded from the log on load
 * (see projection.ts), so the log stays the single source of truth and a replay
 * bug cannot produce a state the log disagrees with.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  session_id  TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  ts          INTEGER NOT NULL,
  actor_id    TEXT,
  body        TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS events_by_session ON events (session_id, seq);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  github_id     TEXT NOT NULL UNIQUE,
  github_login  TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  avatar_url    TEXT
);

/* Single-use, short-lived, exchanged for a participant token by the plugin. */
CREATE TABLE IF NOT EXISTS join_tokens (
  token       TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER
);

/* CSRF state for the OAuth redirect, cleared as soon as it comes back. */
CREATE TABLE IF NOT EXISTS oauth_states (
  state       TEXT PRIMARY KEY,
  redirect_to TEXT,
  created_at  INTEGER NOT NULL
);
`

export interface EventRow {
  session_id: string
  seq: number
  ts: number
  actor_id: string | null
  body: string
}

export class Store {
  private readonly db: DatabaseSync

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec(SCHEMA)
  }

  createSession(id: SessionId, slug: string, createdAt: number): void {
    this.db
      .prepare('INSERT INTO sessions (id, slug, created_at) VALUES (?, ?, ?)')
      .run(id, slug, createdAt)
  }

  findSessionIdByRef(ref: string): SessionId | null {
    const row = this.db
      .prepare('SELECT id FROM sessions WHERE id = ? OR slug = ? LIMIT 1')
      .get(ref, ref) as { id: string } | undefined
    return (row?.id as SessionId) ?? null
  }

  listSessionIds(): SessionId[] {
    const rows = this.db.prepare('SELECT id FROM sessions ORDER BY created_at').all() as Array<{
      id: string
    }>
    return rows.map((r) => r.id as SessionId)
  }

  /**
   * Appends and returns the stamped envelope. The max(seq) read and the insert
   * share one transaction, so two connections racing to append cannot be handed
   * the same seq -- ordering is what every client's reconnect logic depends on.
   */
  /**
   * Runs `fn` as one transaction. A command can append several events, and a
   * failure after the first must not leave the rest of the log believing in
   * half of it -- a lease granted with no task state behind it, say. Appends
   * inside join it rather than committing on their own.
   */
  transaction<T>(fn: () => T): T {
    if (this.depth > 0) return fn()
    this.db.exec('BEGIN IMMEDIATE')
    this.depth++
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    } finally {
      this.depth--
    }
  }

  private depth = 0

  append(sessionId: SessionId, actorId: ParticipantId | null, body: EventBody): EventEnvelope {
    if (this.depth > 0) return this.insert(sessionId, actorId, body)
    return this.transaction(() => this.insert(sessionId, actorId, body))
  }

  private insert(sessionId: SessionId, actorId: ParticipantId | null, body: EventBody): EventEnvelope {
    const ts = Date.now()
    let envelope: EventEnvelope | null = null

    {
      const row = this.db
        .prepare('SELECT COALESCE(MAX(seq), -1) AS max_seq FROM events WHERE session_id = ?')
        .get(sessionId) as { max_seq: number }
      const seq = row.max_seq + 1
      this.db
        .prepare('INSERT INTO events (session_id, seq, ts, actor_id, body) VALUES (?, ?, ?, ?, ?)')
        .run(sessionId, seq, ts, actorId, JSON.stringify(body))
      envelope = { seq, sessionId, actorId, ts, body }
    }

    return envelope
  }

  /**
   * Puts a log back exactly as it was written elsewhere: the same session id,
   * the same seqs, the same timestamps and authors. Used to restore a session
   * from its mirror, so everything that refers to an id -- tokens, tasks,
   * leases -- means what it meant before.
   *
   * Only ever extends. Events this store already has are checked against the
   * incoming ones and skipped; anything that disagrees, or a gap, refuses the
   * whole import rather than splicing two histories together.
   */
  importEvents(
    sessionId: SessionId,
    slug: string,
    events: Array<Pick<EventEnvelope, 'seq' | 'ts' | 'actorId' | 'body'>>,
  ): { added: number; upToSeq: number } {
    return this.transaction(() => {
      const owner = this.findSessionIdByRef(slug)
      if (owner && owner !== sessionId) {
        throw new Error(`The slug "${slug}" already names another session on this server.`)
      }
      const known = this.db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId)
      if (!known) this.createSession(sessionId, slug, events[0]?.ts ?? Date.now())

      let next = this.maxSeq(sessionId) + 1
      let added = 0
      const existing = this.db.prepare('SELECT body FROM events WHERE session_id = ? AND seq = ?')
      const insert = this.db.prepare(
        'INSERT INTO events (session_id, seq, ts, actor_id, body) VALUES (?, ?, ?, ?, ?)',
      )
      for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
        const body = JSON.stringify(event.body)
        if (event.seq < next) {
          const row = existing.get(sessionId, event.seq) as { body: string } | undefined
          if (row && row.body !== body) {
            throw new Error(`Event ${event.seq} differs from this server's copy; refusing to mix two histories.`)
          }
          continue
        }
        if (event.seq !== next) throw new Error(`The log has a gap before event ${event.seq}.`)
        insert.run(sessionId, event.seq, event.ts, event.actorId, body)
        next++
        added++
      }
      return { added, upToSeq: next - 1 }
    })
  }

  readEvents(sessionId: SessionId, fromSeq = 0, limit = 5000): EventEnvelope[] {
    const rows = this.db
      .prepare(
        'SELECT session_id, seq, ts, actor_id, body FROM events WHERE session_id = ? AND seq >= ? ORDER BY seq LIMIT ?',
      )
      .all(sessionId, fromSeq, limit) as unknown as EventRow[]
    return rows.map(rowToEnvelope)
  }

  maxSeq(sessionId: SessionId): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq), -1) AS max_seq FROM events WHERE session_id = ?')
      .get(sessionId) as { max_seq: number }
    return row.max_seq
  }

  // -- users ---------------------------------------------------------------

  saveUser(user: User): void {
    this.db
      .prepare(
        `INSERT INTO users (id, github_id, github_login, display_name, avatar_url)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(github_id) DO UPDATE SET
           github_login = excluded.github_login,
           display_name = excluded.display_name,
           avatar_url = excluded.avatar_url`,
      )
      .run(user.id, user.githubId, user.githubLogin, user.displayName, user.avatarUrl)
  }

  /** Moves a user to a new identity key, keeping their id and so every seat they hold. */
  rekeyUser(id: string, githubId: string): void {
    this.db.prepare('UPDATE users SET github_id = ? WHERE id = ?').run(githubId, id)
  }

  findUserByGithubId(githubId: string): User | null {
    const row = this.db.prepare('SELECT * FROM users WHERE github_id = ?').get(githubId) as
      | UserRow
      | undefined
    return row ? rowToUser(row) : null
  }

  findUserById(id: string): User | null {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined
    return row ? rowToUser(row) : null
  }

  // -- join tokens ---------------------------------------------------------

  createJoinToken(token: string, userId: string, sessionId: SessionId, expiresAt: number): void {
    this.db
      .prepare('INSERT INTO join_tokens (token, user_id, session_id, expires_at) VALUES (?, ?, ?, ?)')
      .run(token, userId, sessionId, expiresAt)
  }

  /**
   * Claims a token if and only if it is unspent and unexpired. The UPDATE is
   * the check, so two racing redemptions cannot both win.
   */
  redeemJoinToken(token: string, now: number): JoinTokenRow | null {
    const changed = this.db
      .prepare('UPDATE join_tokens SET used_at = ? WHERE token = ? AND used_at IS NULL AND expires_at > ?')
      .run(now, token, now)
    if (changed.changes === 0) return null

    const row = this.db.prepare('SELECT * FROM join_tokens WHERE token = ?').get(token) as
      | { token: string; user_id: string; session_id: string; expires_at: number; used_at: number | null }
      | undefined
    if (!row) return null
    return {
      token: row.token,
      userId: row.user_id,
      sessionId: row.session_id as SessionId,
      expiresAt: row.expires_at,
      usedAt: row.used_at,
    }
  }

  // -- oauth state ---------------------------------------------------------

  createOauthState(state: string, redirectTo: string | null, createdAt: number): void {
    this.db
      .prepare('INSERT INTO oauth_states (state, redirect_to, created_at) VALUES (?, ?, ?)')
      .run(state, redirectTo, createdAt)
  }

  consumeOauthState(state: string): { redirectTo: string | null } | null {
    const row = this.db.prepare('SELECT redirect_to FROM oauth_states WHERE state = ?').get(state) as
      | { redirect_to: string | null }
      | undefined
    if (!row) return null
    this.db.prepare('DELETE FROM oauth_states WHERE state = ?').run(state)
    return { redirectTo: row.redirect_to }
  }

  close(): void {
    this.db.close()
  }
}

interface UserRow {
  id: string
  github_id: string
  github_login: string
  display_name: string
  avatar_url: string | null
}

function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    githubId: row.github_id,
    githubLogin: row.github_login,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
  }
}

function rowToEnvelope(row: EventRow): EventEnvelope {
  return {
    seq: row.seq,
    sessionId: row.session_id as SessionId,
    actorId: (row.actor_id as ParticipantId | null) ?? null,
    ts: row.ts,
    body: JSON.parse(row.body) as EventBody,
  }
}
