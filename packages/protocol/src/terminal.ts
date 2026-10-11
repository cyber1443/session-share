import { z } from 'zod'
import { ParticipantId, TicketId, Timestamp } from './ids.js'

/**
 * A Claude Code running in a real terminal on a ticket member's machine,
 * watched and driven from the board.
 *
 * The bytes never touch the event log: a terminal is a stream, and a stream
 * replayed a week later is noise. What is logged is who opened one, who took
 * the helm and when it closed -- because a terminal can run anything on
 * someone's machine, and "who was typing" is a question that will be asked.
 */
export const TerminalStatus = z.enum(['starting', 'running', 'exited'])
export type TerminalStatus = z.infer<typeof TerminalStatus>

export const TerminalInfo = z.object({
  id: z.string().min(1).max(64),
  ticketId: TicketId,
  /** The seat whose checkout it runs in. */
  hostId: ParticipantId,
  openedBy: ParticipantId,
  /**
   * Who is at the keys. Null is Claude: nobody types, and work queued for the
   * seat is handed to it as it goes idle. A seat is a person driving by hand.
   */
  driver: ParticipantId.nullable(),
  status: TerminalStatus,
  exitCode: z.number().int().nullable(),
  /** Why it stopped, when it did not stop by itself. */
  reason: z.string().max(300).nullable().default(null),
  cols: z.number().int().min(10).max(500),
  rows: z.number().int().min(5).max(200),
  startedAt: Timestamp,
})
export type TerminalInfo = z.infer<typeof TerminalInfo>

/** What a machine says it allows when its terminal host connects. */
export const TerminalAccess = z.enum(['off', 'members'])
export type TerminalAccess = z.infer<typeof TerminalAccess>

const Size = { cols: z.number().int().min(10).max(500), rows: z.number().int().min(5).max(200) }
/** Terminal bytes, base64: the stream is binary and a JSON string is not. */
const Data = z.string().max(1_000_000)

/** Board -> server, on `/term`. One socket per terminal being looked at. */
export const ViewerMessage = z.discriminatedUnion('t', [
  /** Start a Claude Code for a ticket on a member's machine, and watch it. */
  z.object({
    t: z.literal('open'),
    ticketId: TicketId,
    hostId: ParticipantId,
    /** Typed into the new Claude as its first instruction. */
    prompt: z.string().max(4000).nullable().default(null),
    /** Who has the helm from the start: the opener, or Claude. */
    drive: z.enum(['me', 'claude']).default('me'),
    ...Size,
  }),
  z.object({ t: z.literal('attach'), terminalId: z.string().min(1) }),
  z.object({ t: z.literal('input'), data: Data }),
  z.object({ t: z.literal('resize'), ...Size }),
  /** Take the helm, or hand it to Claude. */
  z.object({ t: z.literal('helm'), to: z.enum(['me', 'claude']) }),
  z.object({ t: z.literal('kill') }),
])
export type ViewerMessage = z.infer<typeof ViewerMessage>

/** Server -> board. */
export const ViewerEvent = z.discriminatedUnion('t', [
  z.object({ t: z.literal('state'), terminal: TerminalInfo }),
  /** What it printed before this board was looking, so the screen is not blank. */
  z.object({ t: z.literal('replay'), data: Data }),
  z.object({ t: z.literal('output'), data: Data }),
  z.object({ t: z.literal('error'), message: z.string() }),
])
export type ViewerEvent = z.infer<typeof ViewerEvent>

/** Server -> a machine's terminal host. */
export const HostCommand = z.discriminatedUnion('t', [
  z.object({ t: z.literal('welcome'), participantId: ParticipantId }),
  z.object({
    t: z.literal('open'),
    terminalId: z.string().min(1),
    ticketId: TicketId,
    ticketTitle: z.string(),
    prompt: z.string().nullable(),
    ...Size,
  }),
  z.object({ t: z.literal('input'), terminalId: z.string().min(1), data: Data }),
  z.object({ t: z.literal('resize'), terminalId: z.string().min(1), ...Size }),
  z.object({ t: z.literal('helm'), terminalId: z.string().min(1), claude: z.boolean() }),
  z.object({ t: z.literal('kill'), terminalId: z.string().min(1) }),
  z.object({ t: z.literal('refused'), message: z.string() }),
])
export type HostCommand = z.infer<typeof HostCommand>

/** A machine's terminal host -> server. */
export const HostMessage = z.discriminatedUnion('t', [
  /** The checkout's own participant token: the first thing said, or nothing is heard. */
  z.object({ t: z.literal('hello'), token: z.string().min(1), access: TerminalAccess }),
  z.object({ t: z.literal('started'), terminalId: z.string().min(1) }),
  z.object({ t: z.literal('output'), terminalId: z.string().min(1), data: Data }),
  z.object({
    t: z.literal('exit'),
    terminalId: z.string().min(1),
    code: z.number().int().nullable(),
    reason: z.string().max(300).nullable().default(null),
  }),
])
export type HostMessage = z.infer<typeof HostMessage>
