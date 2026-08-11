import { z } from 'zod'
import { ParticipantId, TaskId, Timestamp } from './ids.js'

/**
 * Ephemeral, high-rate data. Never persisted, never seq-ordered, worthless ten
 * seconds after it is produced -- which is exactly why it does not belong in
 * the event log next to task state.
 *
 * P4 ships this over a WebRTC data-channel mesh. A mesh dies around 6 peers
 * (N^2 connections), so past that the same frames fall back to server fan-out
 * over the existing WebSocket, and voice moves to an SFU. Everything upstream
 * of this interface stays unchanged when that happens -- which is the point of
 * having the interface before writing the mesh.
 */
export const ActivityFrame = z.discriminatedUnion('type', [
  /** One line of what an agent is doing right now. Renders on the DAG node. */
  z.object({
    type: z.literal('agent.line'),
    from: ParticipantId,
    taskId: TaskId.nullable(),
    text: z.string().max(200),
    ts: Timestamp,
  }),
  /** Which task a participant is looking at, for presence on the board. */
  z.object({
    type: z.literal('attention'),
    from: ParticipantId,
    taskId: TaskId.nullable(),
    ts: Timestamp,
  }),
  /** Unified-diff preview before a task opens its PR. */
  z.object({
    type: z.literal('diff.preview'),
    from: ParticipantId,
    taskId: TaskId,
    files: z.array(z.object({ path: z.string(), added: z.number(), removed: z.number() })),
    ts: Timestamp,
  }),
  z.object({
    type: z.literal('typing'),
    from: ParticipantId,
    active: z.boolean(),
    ts: Timestamp,
  }),
])
export type ActivityFrame = z.infer<typeof ActivityFrame>

export type ActivityTransportKind = 'webrtc-mesh' | 'ws-fanout'

export interface ActivityTransport {
  readonly kind: ActivityTransportKind
  /** Number of peers this transport can carry before it should be swapped. */
  readonly peerLimit: number
  connect(sessionId: string, self: ParticipantId): Promise<void>
  send(frame: ActivityFrame): void
  onFrame(handler: (frame: ActivityFrame) => void): () => void
  close(): Promise<void>
}

/** Mesh past this many peers means N^2 connections; switch to ws-fanout. */
export const WEBRTC_MESH_PEER_LIMIT = 6
