import type { EventEnvelope, SessionId } from '@session-share/protocol'
import type { Store } from './db.js'

/**
 * One line of a project's history: what happened, when, and by whom, with the
 * heavy parts of the event left behind. A proposed split carries every contract
 * file's contents, and a timeline needs only that there was one.
 */
export interface HistoryEntry {
  seq: number
  ts: number
  actorId: string | null
  type: string
  ticketId?: string | null
  taskId?: string
  title?: string
  state?: string
  ok?: boolean
  prNumber?: number | null
  url?: string
  branch?: string
  summary?: string
  login?: string
  tasks?: Array<{ id: string; title: string }>
  paths?: string[]
  decompositionId?: string
}

/**
 * What one person's own Claude account spent on the project in one day. Kept
 * by login, not by seat: a person with a board and two checkouts is one person
 * to pay, and seats come and go over two years.
 */
export interface UsageDay {
  day: string
  login: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  turns: number
}

export interface ProjectHistory {
  entries: HistoryEntry[]
  usage: UsageDay[]
}

/** The task states worth a line; the rest are a task moving between its own steps. */
const TASK_STATES = new Set(['claimed', 'merged'])

export function toHistoryEntry(envelope: EventEnvelope): HistoryEntry | null {
  const base = { seq: envelope.seq, ts: envelope.ts, actorId: envelope.actorId, type: envelope.body.type }
  const body = envelope.body
  switch (body.type) {
    case 'session.created':
      return { ...base, title: body.session.title }
    case 'participant.joined':
      return { ...base, login: body.participant.githubLogin, ok: Boolean(body.participant.repoPath) }
    case 'ticket.created':
      return { ...base, ticketId: body.ticket.id, title: body.ticket.title }
    case 'ticket.state':
      return { ...base, ticketId: body.ticketId, state: body.state }
    case 'ticket.verified':
      return {
        ...base,
        ticketId: body.ticketId,
        ok: body.verification.passed,
        summary: body.verification.summary.slice(0, 200),
      }
    case 'ticket.shipped':
      return { ...base, ticketId: body.ticketId, prNumber: body.prNumber }
    case 'ticket.deleted':
      return { ...base, ticketId: body.ticketId }
    case 'decomposition.proposed':
      return {
        ...base,
        ticketId: body.decomposition.ticketId ?? null,
        decompositionId: body.decomposition.id,
        ok: body.validation.ok,
        tasks: body.decomposition.tasks.map((task) => ({ id: task.id, title: task.title })),
      }
    case 'contract.committed':
      return { ...base, decompositionId: body.decompositionId ?? undefined, branch: body.branch, prNumber: body.prNumber }
    case 'tasks.seeded':
      return {
        ...base,
        ticketId: body.tasks[0]?.ticketId ?? null,
        tasks: body.tasks.map((task) => ({ id: task.id, title: task.title })),
      }
    case 'task.state':
      return TASK_STATES.has(body.state) ? { ...base, taskId: body.taskId, state: body.state } : null
    case 'task.test':
      return { ...base, taskId: body.taskId, ok: body.result.passed }
    case 'merge.conflict':
      return { ...base, taskId: body.taskId, paths: body.paths.slice(0, 20) }
    case 'integration.pr':
      return { ...base, prNumber: body.prNumber, url: body.url }
    default:
      return null
  }
}

const PAGE = 5000

interface Fold {
  nextSeq: number
  entries: HistoryEntry[]
  usage: Map<string, UsageDay>
  logins: Map<string, string>
  splitTicket: Map<string, string | null>
}

/**
 * A session's history, kept up to date incrementally. A session can run for
 * months, and reading the whole log each time someone opens the history would
 * get slower every week; each read only folds in what was appended since.
 */
export class History {
  private readonly cache = new Map<SessionId, Fold>()

  constructor(private readonly store: Store) {}

  read(sessionId: SessionId): ProjectHistory {
    const fold: Fold = this.cache.get(sessionId) ?? {
      nextSeq: 0,
      entries: [],
      usage: new Map(),
      logins: new Map(),
      splitTicket: new Map(),
    }
    for (;;) {
      const page = this.store.readEvents(sessionId, fold.nextSeq, PAGE)
      for (const envelope of page) {
        this.apply(fold, envelope)
        fold.nextSeq = envelope.seq + 1
      }
      if (page.length < PAGE) break
    }
    this.cache.set(sessionId, fold)
    return {
      entries: fold.entries,
      usage: [...fold.usage.values()].sort((a, b) => a.day.localeCompare(b.day) || a.login.localeCompare(b.login)),
    }
  }

  private apply(fold: Fold, envelope: EventEnvelope): void {
    const body = envelope.body
    if (body.type === 'participant.joined') {
      fold.logins.set(body.participant.id, body.participant.githubLogin.toLowerCase())
    }
    if (body.type === 'usage.recorded') {
      const login = fold.logins.get(body.participantId) ?? body.participantId
      const day = new Date(envelope.ts).toISOString().slice(0, 10)
      const key = `${day} ${login}`
      const total = fold.usage.get(key) ?? {
        day,
        login,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        turns: 0,
      }
      total.inputTokens += body.inputTokens
      total.outputTokens += body.outputTokens
      total.cacheReadTokens += body.cacheReadTokens
      total.cacheCreationTokens += body.cacheCreationTokens
      total.turns += body.turns
      fold.usage.set(key, total)
      return
    }

    const entry = toHistoryEntry(envelope)
    if (!entry) return
    // A contract names its split, not its ticket; the split said which ticket.
    if (entry.type === 'decomposition.proposed' && entry.decompositionId) {
      fold.splitTicket.set(entry.decompositionId, entry.ticketId ?? null)
    }
    if (entry.type === 'contract.committed' && entry.decompositionId) {
      entry.ticketId = fold.splitTicket.get(entry.decompositionId) ?? null
    }
    fold.entries.push(entry)
  }
}
