import { basename, resolve } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import {
  INVITE_PREFIX,
  findInvite,
  isLoopbackUrl,
  packInvite,
  unpackInvite,
  type RepoRef,
  type SessionSnapshot,
  type TaskState,
} from '@session-share/protocol'
import { CommandError, pair, peerJoin, runCommand } from './client.js'
import { readConfig, writeConfig, type SessionConfig } from './config.js'
import { ensureDaemon, probe, stopDaemon } from './daemon.js'
import { describeDirectives, markCaughtUp, peekDirectives, pendingDirectives } from './inbox.js'
import { boardUrl, openInBrowser } from './open.js'
import {
  addWorktree,
  checkoutBranch,
  contractBranch,
  fetch as gitFetch,
  taskBranch,
} from './git.js'
import { readPreferences } from './preferences.js'
import { registerGitTools } from './tools-git.js'
import { currentBranch, localIdentity, repoRemote, repoRoot } from './identity.js'

const DEFAULT_SERVER_URL = process.env.SESSION_SHARE_URL ?? 'http://127.0.0.1:4310'

/** Session slugs appear in branch names and URLs, so they stay boring. */
function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'session'
  )
}

async function createSession(
  serverUrl: string,
  input: { slug: string; title: string; repo: RepoRef; issueRef: string | null },
): Promise<{ sessionId: string; slug: string; invite: string | null }> {
  const response = await fetch(new URL('/api/sessions', serverUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  const payload = (await response.json()) as {
    sessionId?: string
    slug?: string
    invite?: string | null
    error?: string
    message?: string
  }
  if (!response.ok) throw new Error(payload.message ?? payload.error ?? 'could not create session')
  return {
    sessionId: payload.sessionId!,
    slug: payload.slug!,
    invite: payload.invite ?? null,
  }
}

/** Re-mints an invite for a session that already exists on this server. */
async function mintInvite(serverUrl: string, slug: string): Promise<string> {
  const response = await fetch(new URL(`/api/sessions/${slug}/invite`, serverUrl), { method: 'POST' })
  const payload = (await response.json()) as { invite?: string; message?: string; error?: string }
  if (!response.ok || !payload.invite) {
    throw new Error(payload.message ?? payload.error ?? 'could not mint an invite')
  }
  return payload.invite
}

/**
 * Fails a join before it starts, with the reason rather than the symptom.
 *
 * "That invite is not valid for this server" is what the *server* can say, and
 * it is nearly always wrong about the cause: the token is fine, the guest just
 * reached a different server -- usually their own, because the invite carried a
 * loopback address. Only this side can tell the difference, because only this
 * side knows which server the invite claims to come from.
 */
async function checkReachable(url: string, expectedServerId: string | null): Promise<void> {
  const health = await probe(url, 4000)

  if (!health) {
    throw new Error(
      [
        `Nothing answered at ${url}.`,
        '',
        isLoopbackUrl(url)
          ? 'That address means "this machine", so the invite was minted by a host bound to loopback. Ask them to re-run /ss:host -- their invite cannot reach them from anywhere else.'
          : 'Check that you are on the same network as the host, that their machine is awake, and that their firewall allows incoming connections on that port. If you are not on the same network, they need a tunnel.',
      ].join('\n'),
    )
  }

  if (expectedServerId && health.serverId && health.serverId !== expectedServerId) {
    throw new Error(
      [
        `${url} answered, but it is not the server that minted this invite.`,
        `  invite expects: ${expectedServerId}`,
        `  answered:       ${health.serverId}`,
        '',
        isLoopbackUrl(url)
          ? 'The address inside the invite is loopback, so on your machine it points at your own session-share. The host must re-run /ss:host so the invite carries their network address.'
          : 'Another session-share is listening on that address. The host should re-host, or free the port.',
      ].join('\n'),
    )
  }
}

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
    'ss_host',
    {
      description:
        'Start hosting a session from this machine. Brings up a local coordination server if one is not already running, creates the session for this repository, attaches this checkout, and returns the single string to send a teammate.',
      inputSchema: {
        title: z.string().describe('What the session is for, e.g. "Add a dark mode toggle"'),
        issueRef: z.string().nullish().describe('Issue URL, if there is one'),
        expose: z
          .enum(['lan', 'loopback'])
          .nullish()
          .describe(
            'lan lets teammates on the same network connect; loopback is this machine only. Defaults to your saved preference.',
          ),
      },
    },
    async ({ title, issueRef, expose }) => {
      const root = await repoRoot(REPO_ROOT)
      const identity = await localIdentity()
      const daemon = await ensureDaemon({ expose: expose ?? readPreferences().expose })
      const loopback = `http://127.0.0.1:${daemon.port}`

      const remote = await repoRemote(root)
      const slug = slugify(title)

      /**
       * Hosting the same thing twice rejoins it rather than failing. The host's
       * machine sleeping is a normal way for a session to pause, and the
       * documented recovery is to run this again -- so it has to work.
       */
      let created: { invite: string | null; resumed: boolean }
      try {
        const fresh = await createSession(loopback, {
          slug,
          title,
          repo: {
            owner: remote?.owner ?? 'local',
            name: remote?.name ?? basename(root),
            baseBranch: await currentBranch(root),
            remoteUrl: remote?.remoteUrl ?? root,
          },
          issueRef: issueRef ?? null,
        })
        created = { invite: fresh.invite, resumed: false }
      } catch (error) {
        if (!String(error).includes('is taken')) throw error
        created = { invite: await mintInvite(loopback, slug), resumed: true }
      }

      if (!created.invite) {
        throw new Error('This server verifies identity with GitHub; use the board to invite people.')
      }

      // Everything a guest needs in one string: where to dial, how to get in,
      // and which server minted it so they can tell if they reached the wrong one.
      const health = await probe(loopback)
      const packed = packInvite({
        url: daemon.url,
        token: created.invite,
        serverId: health?.serverId ?? null,
      })
      const joined = await peerJoin(loopback, created.invite, identity, root)

      const cfg: SessionConfig = {
        serverUrl: loopback,
        sessionRef: joined.sessionRef,
        participantId: joined.participantId,
        participantToken: joined.participantToken,
        githubLogin: joined.githubLogin,
        displayName: joined.displayName,
        repoPath: root,
      }
      writeConfig(root, cfg)
      markCaughtUp(cfg) // the room starts here; do not replay an old session at the agent

      const board = boardUrl(daemon.url, packed, joined.githubLogin)
      const opened = readPreferences().openBoard && openInBrowser(board)
      const loopbackOnly = isLoopbackUrl(daemon.url)

      return text(
        [
          created.resumed
            ? `Resumed hosting "${title}" as ${identity.displayName}.`
            : `Hosting "${title}" as ${identity.displayName}.`,
          '',
          'Send your teammate this line:',
          `  /ss:join ${packed}`,
          '',
          opened ? `Board opened: ${board}` : `Board: ${board}`,
          '',
          loopbackOnly
            ? [
                'This invite only works on this machine: the server is bound to loopback,',
                'so the address inside it points at whatever is running on the other person\'s',
                'own port 4310. Re-run with expose="lan"' +
                  (readPreferences().expose === 'lan'
                    ? ' -- and check you are on a network, because no LAN address was found.'
                    : ' to let a teammate on your network in.'),
              ].join('\n')
            : `Reachable on your network at ${daemon.url}. Anyone who has the invite can join; anyone who does not, cannot.`,
          '',
          `Every edit in ${basename(root)} is now checked against this session's file leases.`,
        ].join('\n'),
      )
    },
  )

  server.registerTool(
    'ss_join',
    {
      description:
        'Attach this checkout to a session. Accepts an ssx_ invite from a teammate (peer session, no login) or an ssj_ code from a hosted board.',
      inputSchema: {
        code: z.string().describe('The ssx_ invite or ssj_ code you were sent'),
        serverUrl: z
          .string()
          .nullish()
          .describe('Only for ssj_ codes on a server that is not the default'),
      },
    },
    async ({ code, serverUrl }) => {
      const root = await repoRoot(REPO_ROOT)
      // Accept the invite, the whole `/ss:join …` line, or a pasted board URL.
      const trimmed = findInvite(code) ?? code.trim()
      const packed = unpackInvite(trimmed)

      if (!packed && trimmed.startsWith(INVITE_PREFIX)) {
        throw new Error(
          'That looks like an invite but it is damaged -- most likely it was cut short or wrapped when it was copied. Ask for it again, or have the host re-run /ss:host.',
        )
      }
      if (packed) await checkReachable(packed.url, packed.serverId ?? null)

      const result = packed
        ? await peerJoin(packed.url, packed.token, await localIdentity(), root)
        : await pair(serverUrl ?? DEFAULT_SERVER_URL, trimmed, root)

      const cfg: SessionConfig = {
        serverUrl: packed?.url ?? serverUrl ?? DEFAULT_SERVER_URL,
        sessionRef: result.sessionRef,
        participantId: result.participantId,
        participantToken: result.participantToken,
        githubLogin: result.githubLogin,
        displayName: result.displayName,
        repoPath: root,
      }
      const path = writeConfig(root, cfg)
      markCaughtUp(cfg)

      const board = packed ? boardUrl(packed.url, trimmed, result.githubLogin) : null
      const opened = Boolean(board) && readPreferences().openBoard && openInBrowser(board!)

      return text(
        [
          `Joined "${result.sessionTitle}" as ${result.displayName}.`,
          board ? (opened ? `Board opened: ${board}` : `Board: ${board}`) : '',
          `Config at ${path}.`,
          `Every edit in ${basename(root)} is now checked against the session's file leases.`,
        ]
          .filter(Boolean)
          .join('\n'),
      )
    },
  )

  server.registerTool(
    'ss_board',
    {
      description:
        'Open the live board for the session this checkout is attached to, in the browser. Use it when the board was closed or never opened.',
      inputSchema: {},
    },
    async () => {
      const cfg = config()
      const response = await fetch(new URL(`/api/sessions/${cfg.sessionRef}/invite`, cfg.serverUrl), {
        method: 'POST',
        headers: cfg.participantToken ? { authorization: `Bearer ${cfg.participantToken}` } : {},
      })
      const payload = (await response.json()) as { invite?: string; message?: string }
      if (!response.ok || !payload.invite) {
        throw new Error(payload.message ?? 'Could not get a board link for this session.')
      }

      const health = await probe(cfg.serverUrl)
      const board = boardUrl(
        cfg.serverUrl,
        packInvite({ url: cfg.serverUrl, token: payload.invite, serverId: health?.serverId ?? null }),
        cfg.githubLogin,
      )
      return text(openInBrowser(board) ? `Opened ${board}` : board)
    },
  )

  server.registerTool(
    'ss_worktree',
    {
      description:
        'Create a separate working tree of this repository for a session, so several sessions can run against one clone at the same time. Returns the directory to open a second Claude Code in.',
      inputSchema: {
        title: z
          .string()
          .describe('What that session is for; also names the directory and the branch'),
        issueRef: z.string().nullish(),
        /** An existing session to join there instead of hosting a new one. */
        invite: z.string().nullish().describe('An ssx_ invite, if joining a session rather than hosting one'),
      },
    },
    async ({ title, issueRef, invite }) => {
      const root = await repoRoot(REPO_ROOT)
      const slug = slugify(title)
      const path = resolve(root, '..', `${basename(root)}-${slug}`)
      const branch = `ss/${slug}/work`

      /**
       * Sessions are already independent of each other; what was missing is a
       * place to stand. One Claude Code lives in one directory, so a second
       * concurrent session needs a second directory -- and a worktree is the
       * cheap version of that.
       */
      const created = await addWorktree(root, path, branch, await currentBranch(root))

      return text(
        [
          created === 'existing'
            ? `${path} already exists -- reusing it.`
            : `Created a worktree at ${path} on ${branch}.`,
          '',
          'Open a second Claude Code there and run:',
          invite ? `  /ss:join ${invite.trim()}` : `  /ss:host ${title}`,
          '',
          `  cd ${path}`,
          '',
          'It shares this clone\'s history and remote, so pushes and fetches behave',
          'exactly as they do here. Remove it later with: git worktree remove ' + path,
        ].join('\n'),
      )
    },
  )

  server.registerTool(
    'ss_stop_host',
    {
      description:
        'Stop the coordination server running on this machine. Everyone loses the session until it is started again; the event log survives.',
      inputSchema: {},
    },
    async () => text(stopDaemon() ? 'Stopped.' : 'Nothing was running.'),
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
    'ss_inbox',
    {
      description:
        'Take whatever the session has queued for you and act on it. Use this when you have been told there is work waiting -- a split to propose, tasks to claim, a PR to open. Normally it arrives by itself at the end of a turn; this is for picking it up on demand.',
      inputSchema: {},
    },
    async () => {
      const cfg = config()
      const pending = await pendingDirectives(cfg, 5000)
      if (pending.length === 0) return text('Nothing waiting. The room has asked you for nothing.')

      const state = await snapshot(cfg)
      const names = new Map(state.participants.map((p) => [p.id as string, p.displayName]))
      return text(describeDirectives(pending, names))
    },
  )

  server.registerTool(
    'ss_tickets',
    {
      description:
        'The board: every ticket in this session, which column it is in, who is in it, and how its tasks are going. Read this before asking what to do next.',
      inputSchema: {},
    },
    async () => {
      const cfg = config()
      const state = await snapshot(cfg)
      const names = new Map(state.participants.map((p) => [p.id, p.displayName]))
      const waiting = await peekDirectives(cfg).catch(() => [])
      return text({
        waiting:
          waiting.length > 0
            ? `${waiting.length} instruction(s) are queued for you -- run ss_inbox to take them.`
            : undefined,
        tickets: state.tickets.map((ticket) => ({
          id: ticket.id,
          title: ticket.title,
          column: ticket.state,
          members: ticket.members.map((id) => names.get(id) ?? id),
          mine: ticket.members.includes(cfg.participantId as never),
          tasks: state.tasks
            .filter((task) => task.ticketId === ticket.id)
            .map((task) => `${task.id}: ${task.state}${task.assigneeId ? ` (${names.get(task.assigneeId)})` : ''}`),
          prNumber: ticket.prNumber,
        })),
      })
    },
  )

  server.registerTool(
    'ss_ticket_create',
    {
      description:
        'Open a ticket for a piece of work. Everyone else is told it exists and can join it; joining is all the agreement there is, so no approval follows.',
      inputSchema: {
        title: z.string().min(1).max(200),
        body: z.string().max(4000).nullish().describe('The brief the planner works from'),
      },
    },
    async ({ title, body }) => {
      const cfg = config()
      const { ticket } = await runCommand(cfg, {
        type: 'ticket.create',
        title,
        body: body ?? '',
      })
      return text(
        [
          `Opened "${ticket.title}" (${ticket.id}).`,
          ticket.state === 'splitting'
            ? 'Nobody else is here, so it is already being split.'
            : 'The others have been told; it starts splitting as soon as one of them joins, or when you run ss_ticket_start.',
        ].join('\n'),
      )
    },
  )

  server.registerTool(
    'ss_ticket_join',
    {
      description:
        'Join a ticket. This is the consent step: the split starts immediately and the work is assigned to whoever is in, with nothing further to approve.',
      inputSchema: { ticketId: z.string() },
    },
    async ({ ticketId }) => {
      const cfg = config()
      const { ticket } = await runCommand(cfg, {
        type: 'ticket.join',
        ticketId: ticketId as never,
      })
      return text(`In "${ticket.title}" with ${ticket.members.length} other(s). Column: ${ticket.state}.`)
    },
  )

  server.registerTool(
    'ss_ticket_start',
    {
      description:
        'Start splitting a ticket now instead of waiting for someone else to join it.',
      inputSchema: { ticketId: z.string() },
    },
    async ({ ticketId }) => {
      const cfg = config()
      const { ticket } = await runCommand(cfg, {
        type: 'ticket.start',
        ticketId: ticketId as never,
      })
      return text(`"${ticket.title}" is ${ticket.state}.`)
    },
  )

  server.registerTool(
    'ss_ticket_shipped',
    {
      description:
        'Record the pull request that finished a ticket, which closes its card. Call it after ss_ship.',
      inputSchema: { ticketId: z.string(), prNumber: z.number().int().nullish() },
    },
    async ({ ticketId, prNumber }) => {
      const cfg = config()
      const { ticket } = await runCommand(cfg, {
        type: 'ticket.shipped',
        ticketId: ticketId as never,
        prNumber: prNumber ?? null,
      })
      return text(`"${ticket.title}" is done${ticket.prNumber ? ` (PR #${ticket.prNumber})` : ''}.`)
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
        ticketId: z
          .string()
          .nullish()
          .describe('The ticket being split. Given to you in the request; a ticket split needs no approval and starts at once.'),
      },
    },
    async ({ contract, tasks, ticketId }) => {
      const cfg = config()
      const state = await snapshot(cfg)
      const ticket = ticketId ? state.tickets.find((t) => t.id === ticketId) : null
      const result = await runCommand(cfg, {
        type: 'decomposition.propose',
        contract,
        tasks: tasks as never,
        participantCount: Math.max(ticket ? ticket.members.length : state.participants.length, 1),
        issueRef: state.session.issueRef,
        ticketId: (ticketId ?? null) as never,
      })

      if (result.validation.ok) {
        // The server balances the split across whoever has a checkout the
        // moment it lands, so report who ended up with what rather than
        // leaving the team to work it out.
        const after = await snapshot(cfg)
        const names = new Map(after.participants.map((p) => [p.id, p.displayName]))
        return text({
          accepted: true,
          decompositionId: result.decompositionId,
          maxParallel: result.validation.maxFrontier,
          warnings: result.validation.issues,
          assigned: (after.decomposition?.assignments ?? []).map((a) => ({
            task: a.taskId,
            to: names.get(a.participantId) ?? a.participantId,
          })),
          next: ticketId
            ? 'Live already -- a ticket split needs no approval. Everyone in the ticket has been told what they own; do your own tasks now.'
            : 'The board shows the split with the proposed assignment. Anyone can move a card; approving seeds the tasks and tells each agent what it owns.',
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
          ? 'Approved. Tasks are seeded and each assignee has been told what they own; land the contract to make them claimable.'
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

      // Claiming puts you on the task's branch, off the contract. Working on
      // the wrong branch is the failure the whole split exists to avoid.
      const root = await repoRoot(REPO_ROOT)
      const state = await snapshot(cfg)
      const branch = taskBranch(state.session.slug, result.task.id)
      let branchNote = `on ${branch}`
      try {
        await gitFetch(root)
        await checkoutBranch(root, branch, contractBranch(state.session.slug))
        await runCommand(cfg, {
          type: 'task.branch',
          taskId: result.task.id,
          branch,
          prNumber: null,
        })
      } catch (error) {
        branchNote = `could not switch branch: ${error instanceof Error ? error.message : error}`
      }

      return text({
        claimed: result.task.id,
        branch: branchNote,
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
      inputSchema: {
        body: z.string().min(1).max(8000),
        taskRef: z.string().nullish(),
        directive: z
          .boolean()
          .nullish()
          .describe(
            'Deliver this into the other agents\' Claude Code sessions instead of only showing it in the room. Use @login to aim it at one person.',
          ),
      },
    },
    async ({ body, taskRef, directive }) => {
      const cfg = config()
      const { message } = await runCommand(cfg, {
        type: 'chat.post',
        body,
        taskRef: (taskRef ?? null) as never,
        asAgent: true,
        directive: directive ?? false,
      })
      return text(
        `Posted${message.taskRef ? ` on #${message.taskRef}` : ''}${message.directive ? ' as a directive -- it will run in the other agents.' : '.'}`,
      )
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

  registerGitTools(server, {
    repoRoot: () => repoRoot(REPO_ROOT),
    config,
    snapshot,
    text,
  })

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
