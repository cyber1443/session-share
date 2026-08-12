import { z } from 'zod'

/**
 * All ids are opaque strings. Task ids are the exception: they are authored by
 * the planner agent and must be human-typeable, because they appear in chat as
 * `#<task-id>` refs and in branch names as `ss/<session>/<task-id>`.
 */
export const SessionId = z.string().min(1).brand<'SessionId'>()
export const ParticipantId = z.string().min(1).brand<'ParticipantId'>()
export const DecompositionId = z.string().min(1).brand<'DecompositionId'>()
export const MessageId = z.string().min(1).brand<'MessageId'>()
export const TicketId = z.string().min(1).brand<'TicketId'>()

export const TaskId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/, 'task id must be kebab-case, 3-40 chars')
  .brand<'TaskId'>()

export type SessionId = z.infer<typeof SessionId>
export type ParticipantId = z.infer<typeof ParticipantId>
export type DecompositionId = z.infer<typeof DecompositionId>
export type MessageId = z.infer<typeof MessageId>
export type TicketId = z.infer<typeof TicketId>
export type TaskId = z.infer<typeof TaskId>

/** Monotonic per-session sequence number stamped on every persisted event. */
export const Seq = z.number().int().nonnegative()
export type Seq = z.infer<typeof Seq>

/** Milliseconds since epoch. */
export const Timestamp = z.number().int().nonnegative()
export type Timestamp = z.infer<typeof Timestamp>
