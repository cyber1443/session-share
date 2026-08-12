import { z } from 'zod'
import {
  Assignment,
  ChatMessage,
  Ticket,
  TicketState,
  Verification,
  Decomposition,
  HandoffRequest,
  Lease,
  MergeQueueEntry,
  Participant,
  ParticipantActivity,
  Session,
  SessionPhase,
  Task,
  TaskState,
  TestResult,
  ValidationReport,
} from './domain.js'
import { ParticipantId, SessionId, Seq, TaskId, TicketId, Timestamp } from './ids.js'

/**
 * Every mutation to durable session state is one of these events, appended to a
 * per-session log and stamped with a monotonic `seq`. All server-side tables
 * other than `events` are projections and can be rebuilt by replaying the log.
 *
 * Ephemeral, high-rate data (agent token streams, cursors, voice) is NOT an
 * event -- it rides the ActivityTransport instead. See transport.ts.
 */
export const EventBody = z.discriminatedUnion('type', [
  // -- session lifecycle ----------------------------------------------------
  z.object({ type: z.literal('session.created'), session: Session }),
  z.object({ type: z.literal('session.phase'), phase: SessionPhase }),
  z.object({ type: z.literal('session.lead'), leadId: ParticipantId }),

  // -- participants ---------------------------------------------------------
  z.object({ type: z.literal('participant.joined'), participant: Participant }),
  z.object({ type: z.literal('participant.left'), participantId: ParticipantId }),
  z.object({
    type: z.literal('participant.connection'),
    participantId: ParticipantId,
    connected: z.boolean(),
  }),
  z.object({
    type: z.literal('participant.activity'),
    participantId: ParticipantId,
    activity: ParticipantActivity,
  }),
  /** A checkout was paired to an existing participant via /ss:join. */
  z.object({
    type: z.literal('participant.attached'),
    participantId: ParticipantId,
    repoPath: z.string().min(1),
  }),

  // -- tickets --------------------------------------------------------------
  z.object({ type: z.literal('ticket.created'), ticket: Ticket }),
  z.object({
    type: z.literal('ticket.members'),
    ticketId: TicketId,
    members: z.array(ParticipantId),
  }),
  z.object({ type: z.literal('ticket.state'), ticketId: TicketId, state: TicketState }),
  z.object({ type: z.literal('ticket.verified'), ticketId: TicketId, verification: Verification }),
  z.object({
    type: z.literal('ticket.shipped'),
    ticketId: TicketId,
    prNumber: z.number().int().nullable(),
  }),
  /**
   * The card is gone, along with its tasks and their leases. Anything already
   * merged stays merged -- this removes a card from a board, not commits from a
   * branch, and nothing here would be honest if it claimed otherwise.
   */
  z.object({ type: z.literal('ticket.deleted'), ticketId: TicketId }),

  // -- decomposition --------------------------------------------------------
  /** Someone asked for a split from the board and named whose agent does it. */
  z.object({
    type: z.literal('plan.requested'),
    goal: z.string(),
    issueRef: z.string().nullable(),
    plannerId: ParticipantId,
  }),
  z.object({
    type: z.literal('decomposition.proposed'),
    decomposition: Decomposition,
    validation: ValidationReport,
  }),
  z.object({
    type: z.literal('decomposition.approval'),
    participantId: ParticipantId,
    approvals: z.array(ParticipantId),
    /** True once the approval rule is satisfied: unanimous at <=3, lead above. */
    satisfied: z.boolean(),
  }),
  /**
   * Who is meant to do what. Emitted once automatically per proposal and again
   * on every manual move, always as the complete arrangement rather than a
   * delta -- a partial update replayed out of order would be unreadable.
   */
  z.object({
    type: z.literal('decomposition.assigned'),
    assignments: z.array(Assignment),
  }),
  z.object({
    type: z.literal('decomposition.rejected'),
    participantId: ParticipantId,
    reason: z.string().max(500),
  }),
  z.object({
    type: z.literal('contract.committed'),
    branch: z.string().min(1),
    commitSha: z.string().min(1),
    prNumber: z.number().int().nullable(),
  }),

  // -- tasks ----------------------------------------------------------------
  z.object({ type: z.literal('tasks.seeded'), tasks: z.array(Task) }),
  z.object({ type: z.literal('task.assigned'), taskId: TaskId, assigneeId: ParticipantId.nullable() }),
  z.object({
    type: z.literal('task.state'),
    taskId: TaskId,
    state: TaskState,
    ownerId: ParticipantId.nullable(),
  }),
  z.object({
    type: z.literal('task.branch'),
    taskId: TaskId,
    branch: z.string().min(1),
    prNumber: z.number().int().nullable(),
  }),
  z.object({ type: z.literal('task.test'), taskId: TaskId, result: TestResult }),

  // -- leases ---------------------------------------------------------------
  z.object({ type: z.literal('lease.granted'), lease: Lease }),
  z.object({
    type: z.literal('lease.released'),
    taskId: TaskId,
    holderId: ParticipantId,
  }),
  /**
   * Emitted when the PreToolUse hook blocks a write. Surfaced on the board and
   * in chat, because a stream of these means the decomposition drew the seam in
   * the wrong place and something needs hoisting into the contract.
   */
  z.object({
    type: z.literal('lease.denied'),
    participantId: ParticipantId,
    path: z.string().min(1),
    heldBy: ParticipantId.nullable(),
    heldByTaskId: TaskId.nullable(),
  }),
  z.object({ type: z.literal('handoff.requested'), request: HandoffRequest }),
  z.object({
    type: z.literal('handoff.resolved'),
    requestId: z.string().min(1),
    granted: z.boolean(),
    resolvedBy: ParticipantId,
  }),

  // -- chat -----------------------------------------------------------------
  z.object({ type: z.literal('chat.message'), message: ChatMessage }),

  // -- merge queue ----------------------------------------------------------
  z.object({
    type: z.literal('usage.recorded'),
    participantId: ParticipantId,
    ticketId: TicketId.nullable(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    cacheCreationTokens: z.number().int().nonnegative(),
    turns: z.number().int().nonnegative(),
  }),

  z.object({ type: z.literal('merge.queue'), entries: z.array(MergeQueueEntry) }),
  z.object({
    type: z.literal('merge.conflict'),
    taskId: TaskId,
    paths: z.array(z.string()),
    /** Handed to the owning dev's Claude via /ss:resolve. */
    detail: z.string(),
  }),
  z.object({
    type: z.literal('integration.pr'),
    prNumber: z.number().int(),
    url: z.string(),
  }),
])
export type EventBody = z.infer<typeof EventBody>
export type EventType = EventBody['type']

export const EventEnvelope = z.object({
  seq: Seq,
  sessionId: SessionId,
  /** Who caused it; null for server-originated events (merge queue, webhooks). */
  actorId: ParticipantId.nullable(),
  ts: Timestamp,
  body: EventBody,
})
export type EventEnvelope = z.infer<typeof EventEnvelope>

/** Narrow an envelope to a specific event type without a cast at the call site. */
export function isEvent<T extends EventType>(
  envelope: EventEnvelope,
  type: T,
): envelope is EventEnvelope & { body: Extract<EventBody, { type: T }> } {
  return envelope.body.type === type
}
