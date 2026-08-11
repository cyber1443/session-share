import { z } from 'zod'
import { ClientCommand } from './commands.js'
import { EventEnvelope } from './events.js'
import { Seq } from './ids.js'
import { ActivityFrame } from './transport.js'

export const PROTOCOL_VERSION = 1

export const ErrorCode = z.enum([
  'bad_request',
  'unauthorized',
  'not_found',
  'conflict', // lost a claim race, duplicate repoPath, stale decomposition
  'forbidden', // e.g. approving on someone else's behalf
  'not_ready', // command valid but wrong session phase
  'internal',
])
export type ErrorCode = z.infer<typeof ErrorCode>

export const ClientMessage = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('cmd'),
    v: z.literal(PROTOCOL_VERSION),
    /** Correlates with the ack. Client-generated, unique per connection. */
    reqId: z.string().min(1),
    command: ClientCommand,
  }),
  /**
   * Ephemeral activity, relayed not persisted. This is the `ws-fanout`
   * ActivityTransport: it works from day one and is what a WebRTC mesh
   * replaces later without anything upstream noticing.
   */
  z.object({
    kind: z.literal('frame'),
    v: z.literal(PROTOCOL_VERSION),
    frame: ActivityFrame,
  }),
  z.object({ kind: z.literal('ping'), ts: z.number() }),
])
export type ClientMessage = z.infer<typeof ClientMessage>

export const ServerMessage = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ack'),
    reqId: z.string(),
    data: z.unknown(),
  }),
  z.object({
    kind: z.literal('err'),
    reqId: z.string(),
    code: ErrorCode,
    message: z.string(),
  }),
  /** Live broadcast of a newly appended event. */
  z.object({ kind: z.literal('event'), event: EventEnvelope }),
  /**
   * Ordered backlog after a reconnect. Clients apply these before any buffered
   * live events, then resume from `upToSeq`.
   */
  z.object({
    kind: z.literal('sync'),
    events: z.array(EventEnvelope),
    upToSeq: Seq,
    /** More batches follow; keep buffering live events until the last one. */
    more: z.boolean(),
  }),
  /** Relayed activity from another participant. Never persisted, never ordered. */
  z.object({ kind: z.literal('frame'), frame: ActivityFrame }),
  z.object({ kind: z.literal('pong'), ts: z.number() }),
])
export type ServerMessage = z.infer<typeof ServerMessage>
