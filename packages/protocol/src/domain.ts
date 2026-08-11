import { z } from 'zod'
import {
  DecompositionId,
  MessageId,
  ParticipantId,
  SessionId,
  TaskId,
  Timestamp,
} from './ids.js'

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export const RepoRef = z.object({
  owner: z.string().min(1),
  name: z.string().min(1),
  baseBranch: z.string().min(1).default('main'),
  remoteUrl: z.string().min(1),
})
export type RepoRef = z.infer<typeof RepoRef>

/**
 * Plan  -> decomposition proposed and awaiting approval
 * Build -> contract merged, tasks claimable
 * Integrate -> all tasks merged into the contract branch, final PR open
 */
export const SessionPhase = z.enum(['plan', 'build', 'integrate', 'done'])
export type SessionPhase = z.infer<typeof SessionPhase>

export const Session = z.object({
  id: SessionId,
  slug: z.string().min(1),
  title: z.string().min(1),
  repo: RepoRef,
  issueRef: z.string().nullable(),
  phase: SessionPhase,
  /** Whoever ran /ss:plan. Holds the approval vote once participants > 3. */
  leadId: ParticipantId.nullable(),
  contractBranch: z.string().nullable(),
  /**
   * What the session was asked to build, in the words of whoever asked. Set
   * from the board's plan panel; the title is a name, this is the brief the
   * planner works from.
   */
  goal: z.string().nullable().default(null),
  createdAt: Timestamp,
})
export type Session = z.infer<typeof Session>

// ---------------------------------------------------------------------------
// Participants
// ---------------------------------------------------------------------------

/** What a participant's agent is doing right now, as one line for the rail. */
export const ParticipantActivity = z.object({
  state: z.enum(['idle', 'planning', 'working', 'testing', 'blocked', 'offline']),
  detail: z.string().max(120),
  taskId: TaskId.nullable(),
  updatedAt: Timestamp,
})
export type ParticipantActivity = z.infer<typeof ParticipantActivity>

export const Participant = z.object({
  id: ParticipantId,
  sessionId: SessionId,
  /** The authenticated account behind this participant, once there is one. */
  userId: z.string().nullable(),
  githubLogin: z.string().min(1),
  displayName: z.string().min(1),
  avatarUrl: z.string().nullable(),
  /** Index into the fixed 8-colour board palette. Assigned on join, stable. */
  colorIndex: z.number().int().min(0).max(7),
  /**
   * Absolute path of this participant's checkout, or null for someone watching
   * from the board without one. Two participants sharing one path means two
   * Claude Codes in one working tree, which corrupts both -- the server rejects
   * that join.
   */
  repoPath: z.string().min(1).nullable(),
  connected: z.boolean(),
  activity: ParticipantActivity,
  joinedAt: Timestamp,
})
export type Participant = z.infer<typeof Participant>

// ---------------------------------------------------------------------------
// Decomposition: the contract-first split
// ---------------------------------------------------------------------------

/**
 * The seam. Committed to its own branch before any task starts, so no two
 * tasks ever need to edit the same shared type, schema or stub.
 */
export const ContractFile = z.object({
  path: z.string().min(1),
  purpose: z.string().min(1),
  contents: z.string(),
})
export type ContractFile = z.infer<typeof ContractFile>

export const Contract = z.object({
  summary: z.string().min(1),
  files: z.array(ContractFile).min(1),
})
export type Contract = z.infer<typeof Contract>

/** A task is only a task if one command proves it. No test -> not a task. */
export const Acceptance = z.object({
  testCommand: z.string().min(1),
  testFiles: z.array(z.string().min(1)),
  manualChecks: z.array(z.string().min(1)).default([]),
})
export type Acceptance = z.infer<typeof Acceptance>

export const TaskSpec = z.object({
  id: TaskId,
  title: z.string().min(1).max(80),
  intent: z.string().min(1),
  /**
   * Globs this task exclusively owns. The lease is granted over exactly these,
   * and the PreToolUse hook denies edits outside them.
   */
  ownedPaths: z.array(z.string().min(1)).min(1),
  dependsOn: z.array(TaskId).default([]),
  /** What this task may rely on already existing, all of it from the contract. */
  assumes: z.array(z.string().min(1)).default([]),
  acceptance: Acceptance,
  estimateMinutes: z.number().int().min(5).max(240),
})
export type TaskSpec = z.infer<typeof TaskSpec>

/**
 * One card and who has it. `manual` marks a choice a person made, which the
 * automatic balancer treats as fixed -- otherwise moving one card would be
 * undone by the next rebalance.
 */
export const Assignment = z.object({
  taskId: TaskId,
  participantId: ParticipantId,
  manual: z.boolean().default(false),
})
export type Assignment = z.infer<typeof Assignment>

export const DecompositionStatus = z.enum(['proposed', 'approved', 'rejected'])
export type DecompositionStatus = z.infer<typeof DecompositionStatus>

export const Decomposition = z.object({
  id: DecompositionId,
  sessionId: SessionId,
  issueRef: z.string().nullable(),
  contract: Contract,
  tasks: z.array(TaskSpec).min(1),
  /** Planner input: how wide the ready-frontier needs to be to keep everyone busy. */
  participantCount: z.number().int().min(1),
  proposedBy: ParticipantId,
  status: DecompositionStatus,
  approvals: z.array(ParticipantId).default([]),
  /**
   * Who is meant to do what, decided while the split is still a proposal.
   *
   * Kept here rather than on the TaskSpec because the planner does not decide
   * it: the server proposes a balanced assignment the moment a split arrives,
   * people move cards around on the board, and approval is what turns the
   * final arrangement into tasks.
   */
  assignments: z.array(Assignment).default([]),
  createdAt: Timestamp,
})
export type Decomposition = z.infer<typeof Decomposition>

// ---------------------------------------------------------------------------
// Validation report (deterministic, server-side -- never an LLM judgement)
// ---------------------------------------------------------------------------

export const ValidationCode = z.enum([
  'overlapping_paths',
  'dependency_cycle',
  'unknown_dependency',
  'missing_acceptance',
  'path_escapes_repo',
  'contract_path_owned_by_task',
  'narrow_frontier',
  'oversized_task',
])
export type ValidationCode = z.infer<typeof ValidationCode>

export const ValidationIssue = z.object({
  code: ValidationCode,
  /** error blocks approval; warning is shown on the board and can be accepted. */
  severity: z.enum(['error', 'warning']),
  message: z.string().min(1),
  taskIds: z.array(TaskId).default([]),
  /** Concrete instruction the planner can act on in its one repair round. */
  repairHint: z.string().min(1),
})
export type ValidationIssue = z.infer<typeof ValidationIssue>

export const ValidationReport = z.object({
  ok: z.boolean(),
  issues: z.array(ValidationIssue),
  /** Max number of tasks simultaneously claimable, per DAG depth. */
  frontierByDepth: z.array(z.number().int().nonnegative()),
  maxFrontier: z.number().int().nonnegative(),
})
export type ValidationReport = z.infer<typeof ValidationReport>

// ---------------------------------------------------------------------------
// Tasks at runtime
// ---------------------------------------------------------------------------

export const TaskState = z.enum([
  'blocked', // an unmerged dependency
  'ready', // claimable
  'claimed', // lease held, agent not started
  'running', // agent editing
  'testing', // acceptance command running
  'pr', // PR open, waiting on CI or merge queue
  'merged', // in the contract branch
  'failed', // acceptance failed, needs another pass
])
export type TaskState = z.infer<typeof TaskState>

export const TestResult = z.object({
  passed: z.boolean(),
  command: z.string(),
  exitCode: z.number().int(),
  summary: z.string().max(2000),
  ranAt: Timestamp,
})
export type TestResult = z.infer<typeof TestResult>

export const Task = TaskSpec.extend({
  sessionId: SessionId,
  state: TaskState,
  /**
   * Who it is meant for, carried over from the approved split. Distinct from
   * `ownerId`, which is who actually holds the lease right now: an assignment
   * is a plan, a claim is a fact.
   */
  assigneeId: ParticipantId.nullable().default(null),
  ownerId: ParticipantId.nullable(),
  branch: z.string().nullable(),
  prNumber: z.number().int().nullable(),
  lastTest: TestResult.nullable(),
  /** Streaming one-liner of what the owning agent is doing, for the DAG node. */
  activityLine: z.string().max(120).nullable(),
  depth: z.number().int().nonnegative(),
})
export type Task = z.infer<typeof Task>

// ---------------------------------------------------------------------------
// Leases
// ---------------------------------------------------------------------------

export const Lease = z.object({
  taskId: TaskId,
  sessionId: SessionId,
  holderId: ParticipantId,
  paths: z.array(z.string().min(1)).min(1),
  grantedAt: Timestamp,
})
export type Lease = z.infer<typeof Lease>

export const HandoffStatus = z.enum(['pending', 'granted', 'denied', 'expired'])
export type HandoffStatus = z.infer<typeof HandoffStatus>

export const HandoffRequest = z.object({
  id: z.string().min(1),
  sessionId: SessionId,
  path: z.string().min(1),
  requesterId: ParticipantId,
  holderId: ParticipantId,
  heldByTaskId: TaskId,
  reason: z.string().max(280),
  status: HandoffStatus,
  createdAt: Timestamp,
})
export type HandoffRequest = z.infer<typeof HandoffRequest>

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

/**
 * Chat is durable and rides the same seq-ordered event log as task state, so a
 * late joiner gets the full room and "what happened" and "what we said" stay
 * one timeline. WebRTC carries voice and throwaway agent streams, never this.
 */
export const ChatAuthorKind = z.enum(['human', 'agent', 'system'])
export type ChatAuthorKind = z.infer<typeof ChatAuthorKind>

export const ChatMessage = z.object({
  id: MessageId,
  sessionId: SessionId,
  authorId: ParticipantId.nullable(), // null for system
  authorKind: ChatAuthorKind,
  body: z.string().min(1).max(8000),
  /** Set by a `#<task-id>` ref; links the message to a DAG node. */
  taskRef: TaskId.nullable(),
  mentions: z.array(ParticipantId).default([]),
  /**
   * A directive is addressed to the other people's *agents*, not to the people:
   * their Claude Code picks it up and acts on it, which is what makes the room
   * usable as a shared terminal rather than only as a place to talk. Mentions
   * narrow it to specific participants; with none it goes to everyone but the
   * author.
   */
  directive: z.boolean().default(false),
  createdAt: Timestamp,
})
export type ChatMessage = z.infer<typeof ChatMessage>

// ---------------------------------------------------------------------------
// Merge queue
// ---------------------------------------------------------------------------

export const MergeQueueEntry = z.object({
  taskId: TaskId,
  position: z.number().int().nonnegative(),
  state: z.enum(['waiting', 'merging', 'merged', 'conflict', 'failed']),
  conflictPaths: z.array(z.string()).default([]),
  updatedAt: Timestamp,
})
export type MergeQueueEntry = z.infer<typeof MergeQueueEntry>

// ---------------------------------------------------------------------------
// Full session snapshot (what a fresh client renders before replaying events)
// ---------------------------------------------------------------------------

export const SessionSnapshot = z.object({
  session: Session,
  participants: z.array(Participant),
  decomposition: Decomposition.nullable(),
  validation: ValidationReport.nullable(),
  tasks: z.array(Task),
  leases: z.array(Lease),
  handoffs: z.array(HandoffRequest),
  chat: z.array(ChatMessage),
  mergeQueue: z.array(MergeQueueEntry),
  seq: z.number().int().nonnegative(),
})
export type SessionSnapshot = z.infer<typeof SessionSnapshot>
