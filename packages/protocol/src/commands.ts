import { z } from 'zod'
import {
  ChatMessage,
  Contract,
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
import { DecompositionId, ParticipantId, SessionId, Seq, TaskId } from './ids.js'

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

  z.object({
    type: z.literal('decomposition.propose'),
    contract: Contract,
    tasks: z.array(TaskSpec).min(1),
    participantCount: z.number().int().min(1),
    issueRef: z.string().nullable().default(null),
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
  'decomposition.propose': ProposeResult
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
