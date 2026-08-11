import { basename } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import type { SessionSnapshot, TaskState } from '@session-share/protocol'
import { CommandError, pair, runCommand } from './client.js'
import { readConfig, writeConfig, type SessionConfig } from './config.js'

const DEFAULT_SERVER_URL = process.env.SESSION_SHARE_URL ?? 'http://127.0.0.1:4310'

/**
 * The agent's own handle on the session. These tools exist so Claude can take
 * part in the coordination rather than being narrated by it: it claims its own
 * work, reports its own progress, and talks in the room when it discovers
 * something the other agent needs to know before it acts.
 */
const REPO_ROOT = process.env.SESSION_SHARE_REPO ?? process.cwd()

function config(): SessionConfig {
  const found = readConfig(REPO_ROOT)
  if (!found) {
    throw new Error('This repo is not attached to a session. Run /ss:join first.')
  }
  return found
}

const text = (value: unknown) => ({
  content: [
    { type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
  ],
})

async function snapshot(cfg: SessionConfig): Promise<SessionSnapshot> {
  const response = await fetch(new URL(`/sessions/${cfg.sessionRef}/snapshot`, cfg.serverUrl), {
    headers: cfg.participantToken ? { authorization: `Bearer ${cfg.participantToken}` } : {},
  })
  if (!response.ok) throw new Error(`Could not read the session: ${response.status}`)
  return (await response.json()) as SessionSnapshot
}

export function createServer(): McpServer {
  const server = new McpServer({ name: 'session-share', version: '0.1.0' })

  server.registerTool(
    'ss_join',
    {
      description:
        'Attach this checkout to a session using the join code shown on the board. The code is single-use and expires in 15 minutes; it carries the identity of whoever generated it, so no login happens here.',
      inputSchema: {
        code: z.string().describe('The ssj_... code copied from the board'),
        serverUrl: z
          .string()
          .default(DEFAULT_SERVER_URL)
          .describe('Coordination server, only if it is not the default'),
      },
    },
    async ({ code, serverUrl }) => {
      const result = await pair(serverUrl, code.trim(), REPO_ROOT)

      const path = writeConfig(REPO_ROOT, {
        serverUrl,
        sessionRef: result.sessionRef,
        participantId: result.participantId,
        participantToken: result.participantToken,
        githubLogin: result.githubLogin,
        displayName: result.displayName,
        repoPath: REPO_ROOT,
      })

      return text(
        `Joined "${result.sessionTitle}" as ${result.displayName}.\nConfig at ${path}.\nEvery edit in ${basename(REPO_ROOT)} is now checked against the session's file leases.`,
      )
    },
  )

  server.registerTool(
    'ss_status',
    {
      description:
        'Current state of the session: phase, who is here, the task DAG with owners, and anything blocked.',
      inputSchema: {},
    },
    async () => {
      const cfg = config()
      const state = await snapshot(cfg)
      return text({
        phase: state.session.phase,
        contractBranch: state.session.contractBranch,
        participants: state.participants.map((p) => ({
          name: p.displayName,
          connected: p.connected,
          doing: p.activity.detail,
        })),
        tasks: state.tasks.map((t) => ({
          id: t.id,
          state: t.state,
          owner: state.participants.find((p) => p.id === t.ownerId)?.displayName ?? null,
          dependsOn: t.dependsOn,
        })),
      })
    },
  )

  server.registerTool(
    'ss_get_my_task',
    {
      description:
        'The task you currently hold, with its intent, the paths you own, what you may assume the contract provides, and the command that proves it done.',
      inputSchema: {},
    },
    async () => {
      const cfg = config()
      const state = await snapshot(cfg)
      const mine = state.tasks.find((t) => t.ownerId === cfg.participantId)
      if (!mine) return text('You hold no task. Use ss_claim to take the next ready one.')
      return text({
        id: mine.id,
        title: mine.title,
        intent: mine.intent,
        ownedPaths: mine.ownedPaths,
        assumes: mine.assumes,
        acceptance: mine.acceptance,
        state: mine.state,
        branch: mine.branch,
      })
    },
  )

  server.registerTool(
    'ss_get_contract',
    {
      description:
        'The contract every task was planned against: the shared types, schemas and stubs. Frozen during the build phase -- read it, do not edit it.',
      inputSchema: {},
    },
    async () => {
      const cfg = config()
      const state = await snapshot(cfg)
      if (!state.decomposition) return text('No decomposition yet.')
      return text({
        summary: state.decomposition.contract.summary,
        files: state.decomposition.contract.files.map((f) => ({
          path: f.path,
          purpose: f.purpose,
        })),
      })
    },
  )

  server.registerTool(
    'ss_propose',
    {
      description:
        'Propose a decomposition: the contract to commit first, then the tasks. The server validates it deterministically and returns every problem with a repair hint. Fix and call again.',
      inputSchema: {
        contract: z.object({
          summary: z.string(),
          files: z
            .array(
              z.object({
                path: z.string(),
                purpose: z.string(),
                contents: z.string().describe('Full file body; this is what gets committed'),
              }),
            )
            .min(1),
        }),
        tasks: z
          .array(
            z.object({
              id: z.string().describe('kebab-case, used in branch names and #chat refs'),
              title: z.string().max(80),
              intent: z.string(),
              ownedPaths: z.array(z.string()).min(1).describe('Repo-relative globs this task exclusively owns'),
              dependsOn: z.array(z.string()).default([]),
              assumes: z.array(z.string()).default([]),
              acceptance: z.object({
                testCommand: z.string().describe('Must fail now and pass when the task is done'),
                testFiles: z.array(z.string()),
                manualChecks: z.array(z.string()).default([]),
              }),
              estimateMinutes: z.number().int().min(5).max(240),
            }),
          )
          .min(1),
      },
    },
    async ({ contract, tasks }) => {
      const cfg = config()
      const state = await snapshot(cfg)
      const result = await runCommand(cfg, {
        type: 'decomposition.propose',
        contract,
        tasks: tasks as never,
        participantCount: Math.max(state.participants.length, 1),
        issueRef: state.session.issueRef,
      })

      if (result.validation.ok) {
        return text({
          accepted: true,
          decompositionId: result.decompositionId,
          maxParallel: result.validation.maxFrontier,
          warnings: result.validation.issues,
          next: 'Ask the team to approve on the board.',
        })
      }
      return text({
        accepted: false,
        mustFix: result.validation.issues.filter((i) => i.severity === 'error'),
        warnings: result.validation.issues.filter((i) => i.severity === 'warning'),
      })
    },
  )

  server.registerTool(
    'ss_approve',
    {
      description:
        'Approve the current decomposition on this participant’s behalf. Once the approval rule is met the tasks are seeded.',
      inputSchema: { decompositionId: z.string() },
    },
    async ({ decompositionId }) => {
      const cfg = config()
      const result = await runCommand(cfg, {
        type: 'decomposition.approve',
        decompositionId: decompositionId as never,
      })
      return text(
        result.satisfied
          ? 'Approved. Tasks are seeded; commit the contract to make them claimable.'
          : `Recorded. ${result.approvals.length} approval(s) so far.`,
      )
    },
  )

  server.registerTool(
    'ss_claim',
    {
      description:
        'Claim a task and take the lease on its paths. Omit taskId to be handed the best ready task.',
      inputSchema: { taskId: z.string().nullish() },
    },
    async ({ taskId }) => {
      const cfg = config()
      const result = await runCommand(cfg, { type: 'task.claim', taskId: (taskId ?? null) as never })
      if (!result.task) return text(result.reason ?? 'Nothing to claim.')
      return text({
        claimed: result.task.id,
        intent: result.task.intent,
        youNowOwn: result.lease?.paths,
        acceptance: result.task.acceptance,
      })
    },
  )

  server.registerTool(
    'ss_release',
    {
      description: 'Give a task back to the ready pool and drop its lease.',
      inputSchema: { taskId: z.string() },
    },
    async ({ taskId }) => {
      const cfg = config()
      await runCommand(cfg, { type: 'task.release', taskId: taskId as never })
      return text(`Released ${taskId}.`)
    },
  )

  server.registerTool(
    'ss_report_progress',
    {
      description:
        'Tell the session what you are doing right now. The line streams onto your task node on the board; use it as you move between files.',
      inputSchema: {
        taskId: z.string(),
        activityLine: z.string().max(120),
        state: z
          .enum(['claimed', 'running', 'testing', 'pr', 'failed'])
          .nullish()
          .describe('Only when the task actually changes phase'),
      },
    },
    async ({ taskId, activityLine, state }) => {
      const cfg = config()
      await runCommand(cfg, {
        type: 'task.progress',
        taskId: taskId as never,
        state: (state ?? null) as TaskState | null,
        activityLine,
      })
      return text('ok')
    },
  )

  server.registerTool(
    'ss_check_lease',
    {
      description:
        'Ask whether you may edit these repo-relative paths before you plan work around them. The PreToolUse hook enforces the same answer on every edit.',
      inputSchema: { paths: z.array(z.string()).min(1) },
    },
    async ({ paths }) => {
      const cfg = config()
      const result = await runCommand(cfg, { type: 'lease.check', paths })
      return text(result.allowed ? 'All of those are yours to edit.' : result.denials)
    },
  )

  server.registerTool(
    'ss_request_handoff',
    {
      description:
        'Ask the current holder for one file you need. They approve or refuse on the board; nothing moves until they do.',
      inputSchema: { path: z.string(), reason: z.string().max(280).default('') },
    },
    async ({ path, reason }) => {
      const cfg = config()
      const { request } = await runCommand(cfg, { type: 'handoff.request', path, reason })
      return text(`Requested ${path} from the holder of "${request.heldByTaskId}". Request ${request.id}.`)
    },
  )

  server.registerTool(
    'ss_resolve_handoff',
    {
      description: 'Grant or refuse a handoff request for a path you hold.',
      inputSchema: { requestId: z.string(), granted: z.boolean() },
    },
    async ({ requestId, granted }) => {
      const cfg = config()
      await runCommand(cfg, { type: 'handoff.resolve', requestId, granted })
      return text(granted ? 'Granted.' : 'Refused.')
    },
  )

  server.registerTool(
    'ss_report_test',
    {
      description:
        'Report the result of the acceptance command. Passing moves the task to PR; failing marks it failed and keeps the lease.',
      inputSchema: {
        taskId: z.string(),
        passed: z.boolean(),
        command: z.string(),
        exitCode: z.number(),
        summary: z.string().max(2000),
      },
    },
    async ({ taskId, passed, command, exitCode, summary }) => {
      const cfg = config()
      await runCommand(cfg, {
        type: 'task.testResult',
        taskId: taskId as never,
        result: { passed, command, exitCode, summary, ranAt: Date.now() },
      })
      return text('Recorded.')
    },
  )

  server.registerTool(
    'ss_chat_post',
    {
      description:
        'Say something in the session room. Use it when you learn something the other agent must know BEFORE it acts -- a contract gap, a shared assumption that broke, a path you need. Mention a task as #task-id to pin the message to it.',
      inputSchema: { body: z.string().min(1).max(8000), taskRef: z.string().nullish() },
    },
    async ({ body, taskRef }) => {
      const cfg = config()
      const { message } = await runCommand(cfg, {
        type: 'chat.post',
        body,
        taskRef: (taskRef ?? null) as never,
        asAgent: true,
      })
      return text(`Posted${message.taskRef ? ` on #${message.taskRef}` : ''}.`)
    },
  )

  server.registerTool(
    'ss_chat_read',
    {
      description:
        'Read the room. Worth doing before you start a task and before you touch anything shared -- the other agent may have already flagged it.',
      inputSchema: {
        limit: z.number().int().min(1).max(200).default(30),
        taskRef: z.string().nullish(),
      },
    },
    async ({ limit, taskRef }) => {
      const cfg = config()
      const state = await snapshot(cfg)
      const names = new Map(state.participants.map((p) => [p.id, p.displayName]))
      const { messages } = await runCommand(cfg, {
        type: 'chat.read',
        limit,
        beforeSeq: null,
        taskRef: (taskRef ?? null) as never,
      })
      return text(
        messages
          .map(
            (m) =>
              `${(m.authorId ? names.get(m.authorId) : null) ?? 'system'}${m.authorKind === 'agent' ? ' (agent)' : ''}${m.taskRef ? ` #${m.taskRef}` : ''}: ${m.body}`,
          )
          .join('\n') || '(empty room)',
      )
    },
  )

  return server
}

const isEntrypoint = process.argv[1]?.endsWith('mcp.js') ?? false

if (isEntrypoint) {
  const server = createServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  process.stderr.write('[session-share] mcp server ready\n')
}

export { CommandError }
