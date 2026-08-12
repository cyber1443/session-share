import { z } from 'zod'
import {
  Assignment,
  ChatMessage,
  Contract,
  Ticket,
  HandoffRequest,
  Lease,
  ParticipantActivity,
  RepoRef,
  SessionSnapshot,
  Task,
  TaskSpec,
  TaskState,
  TestResult,
  ValidationReport,
} from './domain.js'
import { DecompositionId, ParticipantId, SessionId, Seq, TaskId, TicketId } from './ids.js'

/**
 * Client -> server. Every command is request/response (an `ack` carrying the
 * result) and may additionally cause events to be broadcast to the session.
 */
export const ClientCommand = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('session.create'),
    slug: z.string().min(1),
    title: z.string().min(1),
    repo: RepoRef,
    issueRef: z.string().nullable().default(null),
  }),
  z.object({
    type: z.literal('session.join'),
    /** Either works; the plugin has the slug, the board has the id. */
    sessionRef: z.string().min(1),
    /**
     * Only used when the caller is unauthenticated. An authenticated join takes
     * its identity from the credential, so the board sends neither.
     */
    githubLogin: z.string().min(1).nullish().default(null),
    displayName: z.string().min(1).nullish().default(null),
    /**
     * The checkout being attached. Null when joining from the board with no
     * checkout. Rejected if another connected participant reports the same path.
     */
    repoPath: z.string().min(1).nullable().default(null),
    /** Replay from here instead of receiving a full snapshot. */
    fromSeq: Seq.nullable().default(null),
  }),
  z.object({ type: z.literal('session.sync'), fromSeq: Seq }),

  /**
   * Anyone can open one, from the board or the terminal. The author joins it
   * automatically; everyone else is told it exists and can opt in.
   */
  z.object({
    type: z.literal('ticket.create'),
    title: z.string().min(1).max(200),
    body: z.string().max(4000).default(''),
  }),
  /** Opting in. This is the consent step -- there is no separate approval. */
  z.object({ type: z.literal('ticket.join'), ticketId: TicketId }),
  z.object({ type: z.literal('ticket.leave'), ticketId: TicketId }),
  /** Begin splitting now rather than waiting for someone else to join. */
  z.object({ type: z.literal('ticket.start'), ticketId: TicketId }),
  /**
   * Accept the proposed split and start the work. One click by any member --
   * the point is that a person sees what is about to run before it runs, not
   * that everyone votes.
   */
  z.object({ type: z.literal('ticket.approve'), ticketId: TicketId }),
  /** What running the assembled feature showed. Passing sends it to review. */
  z.object({
    type: z.literal('ticket.verified'),
    ticketId: TicketId,
    passed: z.boolean(),
    how: z.string().max(500),
    summary: z.string().max(2000),
  }),
  /** Records the pull request that finished a ticket. */
  z.object({ type: z.literal('ticket.shipped'), ticketId: TicketId, prNumber: z.number().int().nullable().default(null) }),

  /**
   * Ask for a split from the board. Planning needs a repo and a model, neither
   * of which the browser has -- so this hands the brief to a participant's
   * Claude Code, which reads the repo and answers with `decomposition.propose`.
   */
  z.object({
    type: z.literal('plan.request'),
    goal: z.string().min(1).max(4000),
    issueRef: z.string().nullable().default(null),
    /** Whose agent should do it. Null means the session lead. */
    plannerId: ParticipantId.nullable().default(null),
  }),
  z.object({
    type: z.literal('decomposition.propose'),
    contract: Contract,
    tasks: z.array(TaskSpec).min(1),
    participantCount: z.number().int().min(1),
    issueRef: z.string().nullable().default(null),
    /** The ticket being split. Omitted only by the older session-wide flow. */
    ticketId: TicketId.nullable().default(null),
  }),
  /** Move a card to someone, or to nobody. Overrides the automatic split. */
  z.object({
    type: z.literal('task.assign'),
    taskId: TaskId,
    participantId: ParticipantId.nullable(),
  }),
  z.object({ type: z.literal('decomposition.approve'), decompositionId: DecompositionId }),
  z.object({
    type: z.literal('decomposition.reject'),
    decompositionId: DecompositionId,
    reason: z.string().max(500),
  }),
  z.object({
    type: z.literal('contract.committed'),
    branch: z.string().min(1),
    commitSha: z.string().min(1),
    prNumber: z.number().int().nullable().default(null),
  }),

  /** Omit taskId to be handed the best ready task by affinity. */
  z.object({ type: z.literal('task.claim'), taskId: TaskId.nullable().default(null) }),
  z.object({ type: z.literal('task.release'), taskId: TaskId }),
  z.object({
    type: z.literal('task.progress'),
    taskId: TaskId,
    state: TaskState.nullable().default(null),
    activityLine: z.string().max(120),
  }),
  z.object({ type: z.literal('task.testResult'), taskId: TaskId, result: TestResult }),
  z.object({
    type: z.literal('task.branch'),
    taskId: TaskId,
    branch: z.string().min(1),
    prNumber: z.number().int().nullable().default(null),
  }),
  /**
   * The task's work is in the contract branch. This is what unblocks whatever
   * was waiting on it, so it is the event that actually moves the DAG.
   */
  z.object({ type: z.literal('task.merged'), taskId: TaskId }),

  /** Called by the PreToolUse hook before every Edit/Write. Must be fast. */
  z.object({ type: z.literal('lease.check'), paths: z.array(z.string().min(1)).min(1) }),
  z.object({
    type: z.literal('handoff.request'),
    path: z.string().min(1),
    reason: z.string().max(280).default(''),
  }),
  z.object({
    type: z.literal('handoff.resolve'),
    requestId: z.string().min(1),
    granted: z.boolean(),
  }),

  z.object({
    type: z.literal('chat.post'),
    body: z.string().min(1).max(8000),
    /** Explicit ref; a `#task-id` in the body is also parsed server-side. */
    taskRef: TaskId.nullable().default(null),
    asAgent: z.boolean().default(false),
    /** Deliver this into the other participants' Claude Code sessions. */
    directive: z.boolean().default(false),
  }),
  z.object({
    type: z.literal('chat.read'),
    limit: z.number().int().min(1).max(200).default(50),
    beforeSeq: Seq.nullable().default(null),
    taskRef: TaskId.nullable().default(null),
  }),

  z.object({
    type: z.literal('activity.report'),
    activity: ParticipantActivity.omit({ updatedAt: true }),
  }),
])
export type ClientCommand = z.infer<typeof ClientCommand>
export type CommandType = ClientCommand['type']

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export const LeaseDenial = z.object({
  path: z.string(),
  heldBy: ParticipantId.nullable(),
  heldByTaskId: TaskId.nullable(),
  /** Rendered verbatim by the hook into Claude's deny message. */
  message: z.string(),
})
export type LeaseDenial = z.infer<typeof LeaseDenial>

export const LeaseCheckResult = z.object({
  allowed: z.boolean(),
  denials: z.array(LeaseDenial),
})
export type LeaseCheckResult = z.infer<typeof LeaseCheckResult>

export const JoinResult = z.object({
  participantId: ParticipantId,
  sessionId: SessionId,
  /** Present on a cold join; omitted when resuming from `fromSeq`. */
  snapshot: SessionSnapshot.nullable(),
})
export type JoinResult = z.infer<typeof JoinResult>

export const ProposeResult = z.object({
  decompositionId: DecompositionId,
  validation: ValidationReport,
})
export type ProposeResult = z.infer<typeof ProposeResult>

export const ClaimResult = z.object({
  task: Task.nullable(),
  lease: Lease.nullable(),
  /** Why nothing was handed over: everything blocked, or the claim cap is hit. */
  reason: z.string().nullable(),
})
export type ClaimResult = z.infer<typeof ClaimResult>

/** Typed result per command; `ack.data` is validated against this. */
export interface CommandResultMap {
  'session.create': { sessionId: SessionId; slug: string }
  'session.join': JoinResult
  'session.sync': { upToSeq: Seq }
  /** `plannerId` names whoever was asked to split it, when that just happened. */
  'ticket.create': { ticket: Ticket; plannerId: ParticipantId | null }
  'ticket.join': { ticket: Ticket; plannerId: ParticipantId | null }
  'ticket.leave': { ticket: Ticket }
  'ticket.start': { ticket: Ticket; plannerId: ParticipantId | null }
  'ticket.approve': { ticket: Ticket }
  'ticket.verified': { ticket: Ticket }
  'ticket.shipped': { ticket: Ticket }
  'plan.request': { plannerId: ParticipantId; goal: string }
  'decomposition.propose': ProposeResult
  'task.assign': { assignments: Assignment[] }
  'decomposition.approve': { approvals: ParticipantId[]; satisfied: boolean }
  'decomposition.reject': { ok: true }
  'contract.committed': { ok: true }
  'task.claim': ClaimResult
  'task.release': { ok: true }
  'task.progress': { ok: true }
  'task.testResult': { ok: true }
  'task.branch': { ok: true }
  'task.merged': { unblocked: TaskId[] }
  'lease.check': LeaseCheckResult
  'handoff.request': { request: HandoffRequest }
  'handoff.resolve': { ok: true }
  'chat.post': { message: ChatMessage }
  'chat.read': { messages: ChatMessage[] }
  'activity.report': { ok: true }
}

export type CommandResult<T extends CommandType> = CommandResultMap[T]
