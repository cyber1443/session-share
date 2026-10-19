import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { isLoopbackUrl, pathMatchesAny, verificationHolds, type SessionSnapshot, type Ticket } from '@session-share/protocol'
import { runCommand } from './client.js'
import type { SessionConfig } from './config.js'
import { readDaemon, expectedBuild, lanAddress, probe } from './daemon.js'
import { localIdentity } from './identity.js'
import {
  abortMerge,
  beginMerge,
  canPush,
  changedFiles,
  checkoutBranch,
  commit,
  commitTree,
  conflictMarkers,
  contractBranch,
  currentBranch,
  deleteRef,
  dirtyFiles,
  existingPullRequest,
  foreignChanges,
  indexEntries,
  indexTree,
  insideRepo,
  isAncestor,
  fetch as gitFetch,
  hasRemote,
  logTouching,
  mergeHead,
  mergeInto,
  openPullRequest,
  openPullRequestFor,
  push,
  readyPullRequest,
  revision,
  setRef,
  snapshotWork,
  stage,
  taskBranch,
  treeOf,
  unmergedFiles,
  unstagedChanges,
  updateLocalBranch,
  workingTree,
  writeFiles,
} from './git.js'
import {
  MAX_CHECKS,
  MAX_ROUNDS,
  backupRef,
  clearIntegration,
  readIntegration,
  runAcceptance,
  savedRef,
  unpublishedRef,
  writeIntegration,
  type Integration,
} from './integration.js'
import { describePreferences, readPreferences, writePreferences, PREFERENCES_FILE } from './preferences.js'
import { subjectProblem, taskMessage, taskSubject } from './conventions.js'
import {
  buildOf,
  ensureTerminalHost,
  isAlive,
  readLock,
  stopTerminalHost,
  terminalHostEntry,
  terminalLogFile,
} from './terminal-launch.js'

/** Files session-share puts in a repo itself, which are never someone's work. */
const OWN_ARTIFACTS = ['.session-share/', '.claude/', '.mcp.json', '.gitignore']

interface Context {
  repoRoot: () => Promise<string>
  config: () => SessionConfig
  snapshot: (config: SessionConfig) => Promise<SessionSnapshot>
  text: (value: unknown) => { content: Array<{ type: 'text'; text: string }> }
}

/**
 * The git half of a session. Everything here is the part that was previously
 * left to whoever remembered: creating the branch the contract lives on, giving
 * each task its own branch off it, and landing finished work so the tasks
 * waiting on it become claimable.
 */
export function registerGitTools(server: McpServer, ctx: Context): void {
  server.registerTool(
    'ss_settings',
    {
      description:
        'Read or change how session-share touches this machine: whether queued work runs itself while you are idle (autopilot) and what it may spend, when work is committed, whether branches are pushed, whether pull requests are opened, whether hosting is reachable on the local network, whether the board opens by itself, whether the room can drive this agent, whether the session log is saved to the repository (mirror), whether hosting opens a public tunnel, whether agents reply tersely to save tokens, and whether people in a ticket may open and drive a Claude Code terminal on this machine from the board.',
      inputSchema: {
        commitPolicy: z.enum(['explicit', 'auto-on-green']).nullish(),
        push: z.boolean().nullish(),
        openPullRequests: z.boolean().nullish(),
        expose: z.enum(['lan', 'loopback']).nullish(),
        openBoard: z.boolean().nullish(),
        acceptDirectives: z.boolean().nullish(),
        autopilot: z.enum(['off', 'splits', 'full']).nullish(),
        autopilotBudget: z.number().int().min(0).nullish(),
        mirror: z.boolean().nullish(),
        tunnel: z.boolean().nullish(),
        terse: z.boolean().nullish(),
        terminal: z
          .enum(['off', 'members'])
          .nullish()
          .describe(
            'members: people in a ticket can open a Claude Code in a real terminal on this machine from the board and type into it -- which is running commands here. Off by default.',
          ),
      },
    },
    async (input) => {
      const update: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(input)) {
        if (value !== null && value !== undefined) update[key] = value
      }

      const before = readPreferences().terminal
      const preferences =
        Object.keys(update).length > 0
          ? writePreferences({ ...update, configured: true })
          : readPreferences()
      // The terminal host follows the setting at once, either way.
      if (preferences.terminal !== before) {
        const root = await ctx.repoRoot()
        if (preferences.terminal === 'off') stopTerminalHost(root)
        else ensureTerminalHost(root)
      }

      return ctx.text(
        `${describePreferences(preferences)}\n\nStored in ${PREFERENCES_FILE}.${
          preferences.configured ? '' : '\n\nThese are defaults; nothing has been chosen yet.'
        }`,
      )
    },
  )

  server.registerTool(
    'ss_doctor',
    {
      description:
        'Check whether this machine is ready for a real session: who it will appear as, whether the repo can push, whether a server is running and what address a teammate should dial. Run it on both machines before blaming the session.',
      inputSchema: {},
    },
    async () => {
      const root = await ctx.repoRoot()
      const lines: string[] = []
      const preferences = readPreferences()

      const identity = await localIdentity()
      lines.push(
        `identity   ${identity.displayName} <${identity.githubLogin}>  ${
          identity.source === 'gh'
            ? '(from gh — a real account)'
            : identity.source === 'override'
              ? '(from SESSION_SHARE_LOGIN — a rehearsal, not a real account)'
              : `(from ${identity.source}, since gh is not authenticated here)`
        }`,
      )

      const remote = await hasRemote(root)
      lines.push(
        remote
          ? `remote     origin is set${(await canPush(root)) ? ' and reachable' : ' but could not be reached — check your git credentials'}`
          : 'remote     no origin — branches cannot be shared, so a second machine will never see your work',
      )

      const daemon = readDaemon()
      if (!daemon) {
        lines.push('server     not running here — you are joining, or you have not hosted yet')
      } else {
        const health = await probe(`http://127.0.0.1:${daemon.port}`)
        lines.push(
          `server     ${health ? 'running' : 'recorded but NOT responding'} on port ${daemon.port}, bound to ${
            daemon.expose === 'lan' ? '0.0.0.0' : '127.0.0.1'
          }${health?.serverId ? ` (id ${health.serverId})` : ''}`,
        )

        /**
         * A daemon started before a plugin update keeps serving the old code
         * and the old board, which looks exactly like "the update did nothing".
         */
        const expected = expectedBuild()
        if (health && health.build !== expected) {
          lines.push(
            `build      running ${health.build ?? 'an unknown build'}, installed is ${expected} — this server predates your plugin. Hosting again replaces it; /ss:stop then /ss:host if you want it now`,
          )
        } else if (health?.build) {
          lines.push(`build      ${health.build}, matching the installed plugin`)
        }
        const lan = lanAddress()
        lines.push(
          isLoopbackUrl(daemon.url)
            ? 'reach      loopback only — a teammate on another machine cannot connect, and any invite from here names their own machine, not yours. Re-host with expose "lan", or use a tunnel'
            : `reach      teammates dial ${daemon.url}${lan && !daemon.url.includes(lan) ? ` (this machine is now ${lan} — the invite you sent may be stale)` : ''}`,
        )
      }

      let attached = false
      try {
        const config = ctx.config()
        attached = true
        // The token first, through the client that keeps the server's status and reason.
        await runCommand(config, { type: 'session.sync', fromSeq: 0 })
        const state = await ctx.snapshot(config)
        const mine = state.participants.find((p) => p.id === config.participantId)
        lines.push(`session    "${state.session.title}" — phase ${state.session.phase}`)
        lines.push(
          `you        ${mine?.displayName ?? config.displayName}, ${state.participants.length} participant(s): ${state.participants.map((p) => p.displayName).join(', ')}`,
        )
        lines.push(`server url ${config.serverUrl} — reachable`)
      } catch (error) {
        /**
         * "Did not answer" was said about every failure, including the server
         * answering perfectly clearly that it does not know this token. Those
         * need different fixes, so they get different words -- chosen by the
         * status and reason the server sent, not by searching its prose.
         */
        const message = error instanceof Error ? error.message : String(error)
        const refusal = error as { status?: number | null; reason?: string | null }
        const status = typeof refusal.status === 'number' ? refusal.status : 0
        const reason = refusal.reason ?? null
        lines.push(
          !attached
            ? 'session    this checkout is not attached — run /ss:host or /ss:join'
            : reason === 'seat_gone'
              ? 'session    the session is there, but this checkout\'s seat has left it. Join again with the invite'
              : reason === 'session_gone' || status === 404
                ? 'session    the server answered but has no such session — it was hosted on another server, or its database was reset. Ask for a fresh invite'
                : reason === 'other_session' || status === 403
                  ? 'session    attached, but the token is for a different session than the one configured here. Join again with a fresh invite'
                  : reason === 'token_invalid' || status === 401
                    ? 'session    attached, but the server does not accept this checkout\'s token — it was minted by a different server or a different secret. Join again with a fresh invite'
                    : `session    attached, but the server did not answer: ${message}`,
        )
      }

      if (preferences.terminal === 'off') {
        lines.push('terminal   off -- nobody can open a terminal on this machine from the board')
      } else {
        const lock = readLock(root)
        const entry = terminalHostEntry()
        lines.push(
          lock && isAlive(lock.pid)
            ? `terminal   host running (pid ${lock.pid})${entry && lock.build !== buildOf(entry) ? ' but from an older plugin -- restart Claude Code here to replace it' : ''}`
            : `terminal   on, but no host is running here -- restart Claude Code in this checkout, and see ${terminalLogFile()}`,
        )
      }

      lines.push('')
      lines.push(describePreferences(preferences))

      return ctx.text(lines.join('\n'))
    },
  )

  server.registerTool(
    'ss_land_contract',
    {
      description:
        'Create the session branch, write the approved contract files onto it, commit and push. Tasks only become claimable once this has happened, because every task was planned against these files.',
      inputSchema: {},
    },
    async () => {
      const config = ctx.config()
      const root = await ctx.repoRoot()
      const preferences = readPreferences()
      const state = await ctx.snapshot(config)

      /**
       * Runs once per ticket, not once per session. Every ticket brings its own
       * seam and they all land on the same branch, so this lands every approved
       * split that has not landed yet, in one commit -- and writing the same
       * files twice commits nothing, which is what makes it safe to be told to
       * do this again.
       */
      const splits = Object.values(state.decompositions ?? {}).filter(
        (split) => split.status === 'approved' && !split.contractCommit,
      )
      if (splits.length === 0 && state.decomposition?.status === 'approved') splits.push(state.decomposition)
      if (splits.length === 0) {
        throw new Error(
          state.decomposition
            ? 'No approved split is waiting to land. Approve one on the board first.'
            : 'There is no decomposition yet. Run /ss:plan first.',
        )
      }

      /**
       * session-share's own wiring is not work in progress, and refusing to
       * land because of files this tool created would be the setup blocking
       * itself. Git carries these across a checkout unharmed.
       */
      const dirty = (await dirtyFiles(root)).filter((line) => {
        const path = line.replace(/^\S+\s+/, '')
        return !OWN_ARTIFACTS.some((prefix) => path.startsWith(prefix))
      })
      if (dirty.length > 0) {
        throw new Error(
          `Your working tree has uncommitted changes:\n${dirty.slice(0, 10).join('\n')}\n\nCommit or stash them first — landing the contract switches branches.`,
        )
      }

      const branch = contractBranch(state.session.slug)
      const files = splits.flatMap((split) => split.contract.files)
      const summary = splits.map((split) => split.contract.summary).join('\n\n')
      // Validate every path before switching branches, so a bad split moves nothing.
      for (const file of files) insideRepo(root, file.path)
      await checkoutBranch(root, branch, state.session.repo.baseBranch)

      const written = await writeFiles(root, files)
      const sha = await commit(root, written, `chore(contract): ${state.session.title.toLowerCase()}`.slice(0, 72) + `\n\n${summary}`)

      const pushed = preferences.push ? await push(root, branch) : false

      let prNumber: number | null = null
      if (preferences.openPullRequests && pushed) {
        prNumber =
          (await existingPullRequest(root, branch)) ??
          (await openPullRequest(root, {
            head: branch,
            base: state.session.repo.baseBranch,
            title: state.session.title,
            body: `${summary}\n\nTasks land on this branch as they finish.`,
            draft: true,
          }))
      }

      for (const split of splits) {
        await runCommand(config, {
          type: 'contract.committed',
          branch,
          commitSha: sha ?? 'unchanged',
          prNumber,
          ticketId: split.ticketId,
        })
      }

      return ctx.text(
        [
          `Contract landed on ${branch}${splits.length > 1 ? ` for ${splits.length} tickets` : ''}.`,
          written.length > 0 ? `  ${written.join('\n  ')}` : '  (files already present)',
          '',
          pushed ? 'Pushed to origin.' : 'Not pushed — your teammate cannot see it yet.',
          prNumber ? `Draft PR #${prNumber} opened.` : '',
          '',
          'Tasks are now claimable. Everyone runs /ss:next.',
        ]
          .filter(Boolean)
          .join('\n'),
      )
    },
  )

  server.registerTool(
    'ss_start_task',
    {
      description:
        'Put this checkout on the branch for a task you hold, branching from the contract. Called automatically by ss_claim; use it directly only to get back onto a task branch.',
      inputSchema: { taskId: z.string() },
    },
    async ({ taskId }) => {
      const config = ctx.config()
      const root = await ctx.repoRoot()
      const state = await ctx.snapshot(config)
      const branch = taskBranch(state.session.slug, taskId)

      await gitFetch(root)
      await checkoutBranch(root, branch, contractBranch(state.session.slug))
      await runCommand(config, { type: 'task.branch', taskId: taskId as never, branch, prNumber: null })

      return ctx.text(`On ${branch}, branched from ${contractBranch(state.session.slug)}.`)
    },
  )

  server.registerTool(
    'ss_done',
    {
      description:
        'Finish a task: commit everything under its owned paths, push, open a pull request, and merge it into the contract branch so whatever was waiting on it becomes claimable. If the contract has moved under it, the contract is merged into your task branch, uncommitted. Where it conflicts, resolve the files and call this again; either way this runs the acceptance command itself on exactly that tree, commits the merge only if it passes, and lands it. Bounded: repeated failure stops and is escalated to the room.',
      inputSchema: {
        taskId: z.string(),
        summary: z
          .string()
          .max(500)
          .describe('One line for the commit message, ideally "<type>(<task-id>): <subject>"; otherwise filed as feat(<task-id>)'),
        commits: z
          .array(
            z.object({
              message: z.string().min(1).max(2000).describe('Conventional Commit: "<type>(<scope>): <subject>", optional body after a blank line'),
              paths: z.array(z.string().min(1)).min(1).describe('Exactly the files in this commit'),
            }),
          )
          .optional()
          .describe('Land the work as several atomic commits, in this order. Anything under the task left over goes in a final commit from summary.'),
        force: z
          .boolean()
          .default(false)
          .describe('Land it even though the acceptance command has not passed. Ignored while integrating with the contract: that is always tested here'),
        integration: z
          .enum(['abort', 'retry'])
          .optional()
          .describe(
            'abort: give up on a conflict you cannot resolve safely -- your edits are kept under a ref, the merge is undone, and the room is told. retry: resume once stopped, which works only after a person has written in the room about this task since; never ask for that yourself',
          ),
      },
    },
    async (input) => ctx.text(await finish(input)),
  )

  async function finish({
    taskId,
    summary,
    force,
    commits,
    integration,
  }: {
    taskId: string
    summary: string
    force: boolean
    commits?: Array<{ message: string; paths: string[] }>
    integration?: 'abort' | 'retry'
  }): Promise<string> {
    const config = ctx.config()
    const root = await ctx.repoRoot()
    const preferences = readPreferences()
    const state = await ctx.snapshot(config)

    const task = state.tasks.find((t) => t.id === taskId)
    if (!task) throw new Error(`No task "${taskId}" in this session.`)
    if (task.ownerId !== config.participantId) throw new Error(`You do not hold "${taskId}".`)
    if (task.state === 'merged') return `"${taskId}" is already merged into the contract.`

    const branch = taskBranch(state.session.slug, taskId)
    const contract = contractBranch(state.session.slug)
    /**
     * A granted handoff is a file someone else holds that this task was
     * allowed to edit. Its change is part of this task's work, so it is
     * committed with it rather than counted against it.
     */
    const granted = (state.handoffs ?? [])
      .filter(
        (handoff) =>
          handoff.status === 'granted' &&
          handoff.requesterId === config.participantId &&
          (handoff.requesterTaskId === null || handoff.requesterTaskId === taskId),
      )
      .map((handoff) => handoff.path)
    const paths = [...task.ownedPaths, ...granted]
    const job: Job = {
      ctx,
      config,
      root,
      slug: state.session.slug,
      taskId,
      branch,
      contract,
      paths,
      test: task.acceptance.testCommand,
      summary,
    }

    const recorded = await readIntegration(root, taskId)
    if (recorded && 'legacy' in recorded) {
      /**
       * An older plugin committed resolutions before testing them, so its
       * record may stand for code nobody ran. It is not guessed at.
       */
      return [
        `An integration record for "${taskId}" from an older session-share (version ${recorded.version}) is in this checkout.`,
        'It may describe a conflict resolution that was committed untested, so nothing is landed on it.',
        `A person should look at ${branch}, and remove .git/session-share/integration-${taskId}.json once they have.`,
      ].join('\n')
    }
    let underway = recorded
    const elsewhere = underway && (underway.slug !== job.slug || underway.branch !== branch || underway.contract !== contract)
    if (integration === 'abort') return abandon(job, underway, Boolean(elsewhere))
    if (elsewhere) {
      return [
        `The integration recorded for "${taskId}" is for ${underway!.branch} into ${underway!.contract}, not this session.`,
        'Nothing was landed on it. Call ss_done with integration: "abort" to clear it; no commits are touched.',
      ].join('\n')
    }
    if (underway?.phase === 'escalated') {
      if (integration !== 'retry') return escalated(job, underway)
      const resumed = await resume(job, underway, state)
      if (typeof resumed === 'string') return resumed
      underway = resumed
    }

    let sha: string | null = null
    if (underway) {
      /**
       * Integrating: whatever is in the checkout is a candidate nobody has
       * run. It is tested here, on exactly that tree, and committed only if
       * it passes -- whatever lastTest says and whatever force says.
       */
      const outcome = await recover(job, underway)
      if (typeof outcome === 'string') return outcome
      underway = outcome
      /**
       * Nothing is committed past this point. The tested commit lands as it
       * is, or not at all: an edit that arrived after the run -- even one to
       * the task's own files -- is something nobody ran, and stays uncommitted.
       */
      const moved = await drifted(job, underway)
      if (moved) return moved
      sha = underway.tested!.sha
    } else {
      if (!force && !task.lastTest?.passed) {
        /**
         * A task is done when the command that proves it passes. Landing on an
         * agent's say-so instead would make the acceptance criterion decorative,
         * and the whole split rests on each piece being independently provable.
         */
        return [
          task.lastTest
            ? `"${taskId}" last reported a FAILING acceptance command:`
            : `"${taskId}" has not reported an acceptance result yet:`,
          `  ${task.acceptance.testCommand}`,
          task.lastTest?.summary ? `  ${task.lastTest.summary}` : '',
          '',
          'Run it, report the outcome with ss_report_test, and try again.',
          'If it genuinely should land anyway, call this with force: true and say why in chat.',
        ]
          .filter(Boolean)
          .join('\n')
      }

      /**
       * Finishing switches branches and merges, and git stops partway through
       * either when tracked files outside the task are modified. Better to say
       * so before anything moves than to leave someone stranded mid-way.
       */
      const foreign = await foreignChanges(root, paths, OWN_ARTIFACTS)
      if (foreign.length > 0) {
        return [
          `These changes are outside "${taskId}" and would block switching branches:`,
          ...foreign.slice(0, 10).map((path) => `  ${path}`),
          '',
          'They are not part of this task, so they are not committed with it. Commit them elsewhere, stash them, or unstage them, then finish again.',
        ].join('\n')
      }

      // Checked before anything moves, so a bad message strands nothing.
      for (const planned of commits ?? []) {
        const problem = subjectProblem(planned.message.split('\n')[0]!.trim())
        if (problem) return `${problem}\n\nNothing was committed.`
        const outside = planned.paths.filter((path) => !pathMatchesAny(path, paths))
        if (outside.length > 0) {
          return `These paths are outside "${taskId}": ${outside.join(', ')}\n\nNothing was committed.`
        }
      }

      await checkoutBranch(root, branch, contract)
      for (const planned of commits ?? []) {
        const [subject, ...body] = planned.message.split('\n')
        sha = (await commit(root, planned.paths, taskMessage(taskId, subject!.trim(), body.join('\n')))) ?? sha
      }
      sha = (await commit(root, paths, taskMessage(taskId, taskSubject(taskId, summary)))) ?? sha
    }

    const pushed = preferences.push ? await push(root, branch) : false
    let prNumber: number | null = null
    if (preferences.openPullRequests && pushed) {
      prNumber =
        (await existingPullRequest(root, branch)) ??
        (await openPullRequest(root, {
          head: branch,
          base: contract,
          title: `${taskId}: ${task.title}`,
          body: `${task.intent}\n\nProven by \`${task.acceptance.testCommand}\`.`,
        }))
      if (prNumber) {
        await runCommand(config, { type: 'task.branch', taskId: taskId as never, branch, prNumber })
      }
    }

    /**
     * Take whatever else has landed before merging on top of it. Without
     * this, two people finishing at once each merge into their own stale copy
     * of the contract branch and the second push is rejected -- which strands
     * their task as far as the session is concerned. Diverged is not merged
     * here: that merge would be a contract nobody ran.
     */
    if (preferences.push && (await updateLocalBranch(root, contract)) === 'diverged') {
      return [
        `${contract} here has commits origin does not, and origin has commits it does not.`,
        `Nothing was merged into it. Your work is committed on ${branch}${pushed ? ' and pushed' : ''}.`,
        `Run /ss:sync and bring ${contract} level with origin by hand, then finish again.`,
      ].join('\n')
    }

    const before = await revision(root, contract)
    if (!before) throw new Error(`There is no ${contract} here to land on. Run /ss:sync first.`)
    if (!(await isAncestor(root, before, branch))) {
      /**
       * The contract has moved since this task branched from it. Whether git
       * can put the two together or not, the result is a tree nobody has
       * run, so it is never made on the contract branch: the contract is
       * merged into the task's own branch, uncommitted, and it is tested
       * there -- conflicts resolved by the holder's agent first, if any.
       */
      const round = await conflicted(job, underway, before, sha)
      return round === AGAIN ? finish({ taskId, summary, force, commits }) : round
    }
    if (underway) {
      // Pushing took time; check again that what lands is still exactly what ran.
      const moved = await drifted(job, underway)
      if (moved) return moved
    }

    // The contract is in the task branch already, so this merge holds exactly the task's tree.
    const merge = await mergeInto(root, contract, branch)
    if (!merge.merged) {
      await checkoutBranch(root, branch, contract)
      throw new Error(`${branch} could not be merged into ${contract}, which it already contains: ${merge.conflicts.join(', ')}`)
    }

    if (preferences.push) {
      const published = await publish(root, contract)
      if (published !== 'pushed') {
        /**
         * The merge is fine but origin moved while it was made, or keeps
         * refusing it. The local contract goes back to where it was -- what
         * it held is the task branch plus commits origin has, and the merge
         * itself is kept under a ref -- so nothing local disagrees with
         * origin. If origin moved, the task goes round again against what
         * origin really has, tested on its own branch like any other round.
         */
        const made = await revision(root, contract)
        await checkoutBranch(root, branch, contract)
        if (made) await setRef(root, unpublishedRef(job.slug, taskId), made)
        await setRef(root, `refs/heads/${contract}`, before, made ?? undefined)
        if ('moved' in published) {
          const round = await conflicted(job, underway, published.moved, sha)
          return round === AGAIN ? finish({ taskId, summary, force, commits }) : round
        }
        return [
          `${taskId} merged into ${contract} here, but origin would not take it: ${published.error}`,
          '',
          `Your work is committed on ${branch}${pushed ? ' and pushed' : ''}; the local ${contract} is back where it was`,
          `and the unpublished merge is kept at ${unpublishedRef(job.slug, taskId)}. Nothing is lost.`,
          'Call ss_done again to retry; if it keeps failing, it is not a conflict -- check access to origin.',
        ].join('\n')
      }
    }
    const { unblocked } = await runCommand(config, { type: 'task.merged', taskId: taskId as never })
    if (underway) {
      await clearIntegration(root, taskId)
      await deleteRef(root, backupRef(job.slug, taskId))
    }
    await deleteRef(root, unpublishedRef(job.slug, taskId))
    await checkoutBranch(root, contract, state.session.repo.baseBranch)

    return [
      `${taskId} is merged into ${contract}.`,
      sha ? `  commit ${sha.slice(0, 7)}` : '  nothing new to commit',
      underway?.tested ? `  integrated with ${contract} and tested here: \`${underway.tested.command}\` passed on exactly that commit` : '',
      prNumber ? `  PR #${prNumber}` : '',
      pushed ? '  pushed' : '  not pushed',
      '',
      unblocked.length > 0
        ? `Unblocked: ${unblocked.join(', ')}. Run /ss:next to take one.`
        : 'Nothing was waiting on it. Run /ss:next for whatever is ready.',
    ]
      .filter(Boolean)
      .join('\n')
  }

  server.registerTool(
    'ss_sync',
    {
      description:
        'Fetch and fast-forward the contract branch, so this checkout has whatever your teammates have landed.',
      inputSchema: {},
    },
    async () => {
      const config = ctx.config()
      const root = await ctx.repoRoot()
      const state = await ctx.snapshot(config)
      const contract = contractBranch(state.session.slug)

      const outcome = await updateLocalBranch(root, contract)
      const messages = {
        'no-remote': `origin has no ${contract} yet (or there is no origin), so there is nothing to sync.`,
        unchanged: `${contract} is already up to date with origin.`,
        updated: `${contract} now matches origin.`,
        diverged: `${contract} has commits origin does not, and origin has commits it does not. Merge origin/${contract} into it by hand.`,
      } as const
      const here = await currentBranch(root)
      const hint =
        outcome === 'updated' && here !== contract && here !== 'HEAD'
          ? `\nYou are still on ${here}. Run \`git merge ${contract}\` there if you need what landed.`
          : ''
      return ctx.text(`${messages[outcome]}${hint}`)
    },
  )

  server.registerTool(
    'ss_ship',
    {
      description:
        'Open the pull request for the finished session: the contract branch, with everything merged into it, against the base branch.',
      inputSchema: {},
    },
    async () => {
      const config = ctx.config()
      const root = await ctx.repoRoot()
      const preferences = readPreferences()
      const state = await ctx.snapshot(config)

      const unfinished = state.tasks.filter((task) => task.state !== 'merged')
      if (unfinished.length > 0) {
        return ctx.text(
          [
            `${unfinished.length} task(s) have not landed yet:`,
            ...unfinished.map((task) => `  ${task.id} — ${task.state}`),
            '',
            'Ship once they are merged, or say in chat that you are shipping without them.',
          ].join('\n'),
        )
      }

      const contract = contractBranch(state.session.slug)
      const synced = await updateLocalBranch(root, contract)
      if (synced === 'diverged') {
        return ctx.text(
          `${contract} has diverged from origin. Run /ss:sync and merge origin/${contract} into it before shipping.`,
        )
      }

      /**
       * Every task passing alone is not the feature working. What ships is
       * this exact commit, so every ticket whose work is in it has to have
       * passed a run of exactly this commit -- checked before anything is
       * pushed or opened, since a pull request is already outside the room.
       */
      const head = await revision(root, `refs/heads/${contract}`)
      if (!head) return ctx.text(`There is no ${contract} here to ship. Run /ss:sync first.`)
      const tickets = state.tickets ?? []
      const live = tickets.filter((ticket) => !ticket.mergedAt && state.tasks.some((task) => task.ticketId === ticket.id))
      const unproven = live.filter((ticket) => ticket.state !== 'review' || !verificationHolds(ticket.verification, head))
      /**
       * Work no ticket owns has no assembled run to vouch for it -- a session
       * from before tickets, or a task filed outside one. That is not an
       * exemption: nothing passed on this commit, so nothing ships.
       */
      const loose = state.tasks.filter((task) => !task.ticketId || !tickets.some((ticket) => ticket.id === task.ticketId))
      const vouched = live.length > unproven.length
      if (unproven.length > 0 || loose.length > 0 || !vouched) {
        return ctx.text(
          [
            `Not shipped. ${contract} is at ${head.slice(0, 7)}, and not everything in it has passed a run of that commit:`,
            ...unproven.map((ticket) => `  "${ticket.title}" -- ${unshippable(ticket, head)}`),
            ...loose.map((task) => `  ${task.id} -- in no ticket, so no assembled run of it was ever recorded`),
            ...(live.length === 0 && loose.length === 0 ? ['  nothing in it belongs to a ticket that has been run assembled'] : []),
            '',
            `Check out ${contract}, run the assembled thing end to end, and report it with ss_ticket_verified;`,
            'a failure goes back to whoever built the broken part. Then ship again.',
          ].join('\n'),
        )
      }

      if (preferences.push) await push(root, contract)
      if (!preferences.openPullRequests) {
        return ctx.text(
          `Everything is merged into ${contract}. Opening pull requests is off in /ss:setup, so open ${contract} → ${state.session.repo.baseBranch} yourself.`,
        )
      }

      const body = [
        state.decomposition?.contract.summary ?? '',
        '',
        '## What landed',
        ...state.tasks.map((task) => `- **${task.id}** — ${task.title} (\`${task.acceptance.testCommand}\`)`),
      ].join('\n')

      /**
       * Landing the contract may already have opened this as a draft, to
       * show work in progress. Shipping is the point it stops being one.
       */
      const existing = await openPullRequestFor(root, contract)
      const prNumber =
        existing?.number ??
        (await openPullRequest(root, {
          head: contract,
          base: state.session.repo.baseBranch,
          title: state.session.title,
          body,
        }))
      const stillDraft = existing?.draft ? !(await readyPullRequest(root, existing.number)) : false

      return ctx.text(
        !prNumber
          ? `Everything is merged into ${contract}. Open the PR yourself; gh could not (not installed, not authenticated, or no remote).`
          : [
              `PR #${prNumber}: ${state.session.title} — ${state.tasks.length} tasks, ${contract} → ${state.session.repo.baseBranch}, at ${head.slice(0, 7)}.`,
              existing?.draft
                ? stillDraft
                  ? `It is still a draft: gh could not mark it ready. Mark #${prNumber} ready for review on GitHub.`
                  : 'It was a draft from landing the contract; it is now ready for review.'
                : '',
              `Record it with ss_ticket_shipped. It merges only at ${head.slice(0, 7)}: anything pushed after needs another run.`,
            ]
              .filter(Boolean)
              .join('\n'),
      )
    },
  )
}

function unshippable(ticket: Ticket, head: string): string {
  const run = ticket.verification
  if (!run) return 'never run assembled'
  if (!run.passed) return 'its last run failed'
  if (!run.commitSha) return 'its pass is from before runs named the commit they ran'
  if (run.stale) return 'its work changed after it passed'
  if (run.commitSha !== head) return `it passed at ${run.commitSha.slice(0, 7)}, not at this commit`
  return ticket.needsHuman && !ticket.humanCheck?.passed ? 'it is waiting for a person to look' : `it is in ${ticket.state}`
}

/** Everything the integration steps of one ss_done need to know. */
interface Job {
  ctx: Context
  config: SessionConfig
  root: string
  slug: string
  taskId: string
  branch: string
  contract: string
  /** What the task may change: its owned paths and granted handoffs. */
  paths: string[]
  test: string
  summary: string
}

/** conflicted's answer when git merged cleanly: go round again, and test it. */
const AGAIN = Symbol('again')

/**
 * Begins a round: the contract commit merged into the task's own branch and
 * left there uncommitted -- conflicts and all, or cleanly staged -- since
 * either way it is a tree nobody has run. Past MAX_ROUNDS no merge is started:
 * it goes to a person instead.
 */
async function conflicted(
  job: Job,
  prior: Integration | null,
  contractSha: string,
  committed: string | null,
): Promise<string | typeof AGAIN> {
  const { root, branch, contract } = job
  await checkoutBranch(root, branch, contract)
  const taskHead = (await revision(root, 'HEAD'))!
  const original = prior?.original ?? taskHead
  if (!prior) await setRef(root, backupRef(job.slug, job.taskId), original)
  const round: Integration = {
    version: 2,
    slug: job.slug,
    taskId: job.taskId,
    branch,
    contract,
    original,
    taskHead,
    contractHead: contractSha,
    conflicts: [],
    auto: {},
    phase: 'merging',
    tested: null,
    // Carried over, never restarted: only a person resets the count.
    rounds: (prior?.rounds ?? 0) + 1,
    checks: 0,
    reason: null,
    escalatedAt: null,
    savedRef: null,
    startedAt: Date.now(),
  }
  if (round.rounds > MAX_ROUNDS) {
    return escalate(job, round, `${contract} has moved under it ${MAX_ROUNDS} times running, so the seam is probably in the wrong place`)
  }

  const merge = await beginMerge(root, contractSha)
  await writeIntegration(root, { ...round, conflicts: merge.conflicts, auto: await indexEntries(root) })
  // Clean this way round, but a tree nobody has tested: the next pass tests it and, if it passes, lands it.
  if (merge.merged) return AGAIN

  const theirs = await logTouching(root, `${taskHead}..${contractSha}`, merge.conflicts)
  return [
    `${job.taskId} is committed${committed ? ` (${committed.slice(0, 7)})` : ''}, but it conflicts with what has landed on ${contract}:`,
    ...merge.conflicts.map((path) => `  ${path}`),
    '',
    `${contract} is untouched. Instead it (${contractSha.slice(0, 7)}) is being merged into your own branch, ${branch},`,
    `uncommitted, and the conflicts are waiting in those files for you. Round ${round.rounds} of ${MAX_ROUNDS}.`,
    ...(theirs.length > 0 ? ['', 'What landed there and touches them:', ...theirs.map((line) => `  ${line}`)] : []),
    '',
    'Resolve it now, without waiting to be asked:',
    '1. Read each conflicted file and both sides of it (`git diff`, `git log -p MERGE_HEAD -- <file>`) and work out what each side meant.',
    '2. Edit it so both intents survive. Do not take a side wholesale (`git checkout --ours/--theirs`) unless the other is truly superseded, and then say so in chat.',
    "3. Change only the conflicted files and your own task's files. Do not commit, and do not run git merge, reset or commit yourself.",
    `4. Call ss_done again with the same taskId. It checks no markers are left and nothing else moved, runs \`${job.test}\``,
    '   itself on exactly that tree, and only if it passes commits the merge and lands it. If it fails, nothing is',
    '   committed and your edits stay: fix them and call ss_done again.',
    '',
    `Bounded: ${MAX_CHECKS} failed attempts in a round, or ${MAX_ROUNDS} rounds, and it stops for a person with your edits kept.`,
    'If you cannot tell how the two should fit, do not guess: call ss_done with integration: "abort".',
    `Your branch from before this: ${original.slice(0, 7)}, kept at ${backupRef(job.slug, job.taskId)}.`,
  ].join('\n')
}

/**
 * One pass at integrating: checks the candidate in the checkout, runs the
 * acceptance command on exactly it, and only if that passes commits exactly
 * the tree that ran. Returns the record to land on, or why not.
 *
 * The candidate is the merge in progress (phase merging), or -- after a
 * tested commit could not land yet -- that commit plus whatever was changed
 * since (phase tested). A run vouches for one tree, one HEAD, one merge and
 * one command; if any of them is different afterwards, it vouches for nothing.
 */
async function recover(job: Job, state: Integration): Promise<Integration | string> {
  const { root } = job
  const [here, head, merging] = await Promise.all([currentBranch(root), revision(root, 'HEAD'), mergeHead(root)])
  if (here !== state.branch) return escalate(job, state, `the checkout moved to ${here}, off ${state.branch}, mid-integration`)
  if (state.phase === 'merging') {
    if (head !== state.taskHead || merging !== state.contractHead) {
      return escalate(
        job,
        state,
        merging
          ? `the merge in progress is of ${merging.slice(0, 7)}, not the ${state.contractHead.slice(0, 7)} it started`
          : head !== state.taskHead
            ? `${state.branch} moved to ${head?.slice(0, 7) ?? 'nothing'} while its merge was being resolved`
            : 'the merge it started is no longer in progress, undone or committed by hand',
      )
    }
  } else if (merging || !head || !state.tested || !(await isAncestor(root, state.tested.sha, head))) {
    return escalate(job, state, `${state.branch} no longer holds the tested commit ${state.tested?.sha.slice(0, 7) ?? ''} as it was left`)
  }

  const markers = await conflictMarkers(root, state.conflicts)
  if (markers.length > 0) {
    return handBack(job, state, ['Conflict markers are still in:', ...markers.slice(0, 20).map((line) => `  ${line}`)])
  }

  /**
   * A resolution is the conflicted files, plus whatever of the task's own it
   * took to make them fit. Anything else moving -- something git had merged
   * by itself, someone else's file, a stray untracked file -- is not
   * resolving this conflict: it would be in the tree that is tested, and
   * landing it would carry a change nobody asked for into the contract.
   */
  const allowed = (path: string) => state.conflicts.includes(path) || pathMatchesAny(path, job.paths)
  const own = (path: string) => OWN_ARTIFACTS.some((prefix) => path.startsWith(prefix))
  // Mid-merge, the index already differs from HEAD by the merge; what git merged by itself is checked against `auto`.
  const changed = (state.phase === 'merging' ? await unstagedChanges(root) : await changedFiles(root)).filter((path) => !own(path))
  const strays = changed.filter((path) => !allowed(path))
  await stage(root, changed.filter(allowed))
  const now = await indexEntries(root)
  const moved =
    state.phase === 'merging'
      ? [...new Set([...Object.keys(now), ...Object.keys(state.auto)])].filter(
          (path) => now[path] !== state.auto[path] && !allowed(path) && !own(path),
        )
      : []
  const outside = [...new Set([...moved, ...strays])]
  if (outside.length > 0) {
    return handBack(job, state, [
      'These changed outside the conflict and outside your task:',
      ...outside.slice(0, 20).map((path) => `  ${path}`),
      '',
      'Undo those edits, or move untracked files out of the checkout. If one of them really has to change',
      'for the two sides to fit, that is not yours to decide alone: call ss_done with integration: "abort" and say why.',
    ])
  }
  const unmerged = await unmergedFiles(root)
  if (unmerged.length > 0) {
    return handBack(job, state, ['Still unmerged:', ...unmerged.map((path) => `  ${path}`)])
  }

  const tree = await indexTree(root)
  if ((await workingTree(root, OWN_ARTIFACTS)) !== tree) {
    return handBack(job, state, ['The files on disk are not what would be committed. Run git status, and leave only the resolution.'])
  }
  const headTree = await treeOf(root, head!)
  // Exactly what last passed, by the same command: nothing new to run.
  if (
    state.phase === 'tested' &&
    head === state.tested!.sha &&
    tree === state.tested!.tree &&
    state.tested!.command === job.test
  ) {
    return state
  }

  const ran = await runAcceptance(root, job.test)
  const [headAfter, mergingAfter, treeAfter, onDisk] = await Promise.all([
    revision(root, 'HEAD'),
    mergeHead(root),
    indexTree(root).catch(() => null),
    workingTree(root, OWN_ARTIFACTS).catch(() => null),
  ])
  const intact = headAfter === head && mergingAfter === merging && treeAfter === tree && onDisk === tree
  const passed = ran.passed && intact
  // Best effort: the board shows it, but nothing below depends on the server having heard.
  await runCommand(job.config, {
    type: 'task.testResult',
    taskId: job.taskId as never,
    result: {
      passed,
      command: job.test,
      exitCode: ran.exitCode,
      summary: (intact ? ran.output : `It changed what it was testing, so it proves nothing. ${ran.output}`).slice(0, 2000) || '(no output)',
      ranAt: Date.now(),
    },
  }).catch(() => undefined)

  if (!intact) {
    return handBack(job, state, [
      `\`${job.test}\` changed what it was testing while it ran:`,
      ...(headAfter !== head ? [`  HEAD moved from ${head?.slice(0, 7)} to ${headAfter?.slice(0, 7) ?? 'nothing'}`] : []),
      ...(mergingAfter !== merging ? ['  the merge in progress changed'] : []),
      ...(treeAfter !== tree || onDisk !== tree ? ['  files that would be committed changed'] : []),
      '',
      'A run of one tree says nothing about another, so nothing was committed. Put the files back as they were',
      'resolved (git status shows what moved), make sure the command does not write tracked files, and call ss_done again.',
    ])
  }
  if (!ran.passed) {
    return handBack(job, state, [
      `\`${job.test}\` FAILED (exit ${ran.exitCode}) on the resolution, so it was not committed:`,
      ...ran.output.split('\n').slice(-25).map((line) => `  ${line}`),
      '',
      'The merge is still in progress with your edits in place. Fix it in the conflicted files or your own,',
      'and call ss_done again: it runs the command again itself. force does not apply here.',
    ])
  }

  // Passed, on this tree and nothing else: commit exactly it.
  const tip =
    merging !== null
      ? await commitTree(root, state.branch, tree, [head!, merging], `Merge ${state.contract} into ${state.branch}`)
      : tree === headTree
        ? head!
        : await commitTree(root, state.branch, tree, [head!], taskMessage(job.taskId, taskSubject(job.taskId, job.summary)))
  const next: Integration = { ...state, phase: 'tested', tested: { sha: tip, tree, command: job.test }, checks: 0 }
  await writeIntegration(root, next)
  return next
}

/**
 * Why the tested commit cannot land as it is, or null when it can: the
 * checkout is still on the task branch, at exactly that commit, with no
 * merge in progress and nothing staged or on disk that the run did not see.
 * Never commits or undoes anything; a later edit stays where it is.
 */
async function drifted(job: Job, state: Integration): Promise<string | null> {
  const { root } = job
  const tested = state.tested!
  const [here, head, merging] = await Promise.all([currentBranch(root), revision(root, 'HEAD'), mergeHead(root)])
  if (here !== state.branch || head !== tested.sha || merging) {
    return escalate(
      job,
      state,
      here !== state.branch
        ? `the checkout moved to ${here}, off ${state.branch}, before the tested commit landed`
        : merging
          ? `a merge of ${merging.slice(0, 7)} was begun on ${state.branch} before the tested commit landed`
          : `${state.branch} moved past the tested commit ${tested.sha.slice(0, 7)} before it landed`,
    )
  }
  const [tree, onDisk] = await Promise.all([
    indexTree(root).catch(() => null),
    workingTree(root, OWN_ARTIFACTS).catch(() => null),
  ])
  if (tree === tested.tree && onDisk === tested.tree) return null
  return handBack(job, state, [
    `Files changed after \`${tested.command}\` passed on ${tested.sha.slice(0, 7)} (git status shows which).`,
    'That run says nothing about them, so the tested commit was not landed with them beside it, and they were not committed.',
    'If they belong to the task, call ss_done again: it tests them first. Otherwise undo them and call ss_done again.',
  ])
}

/** An attempt that did not get there. Counted, so an agent going in circles stops. */
async function handBack(job: Job, state: Integration, why: string[]): Promise<string> {
  const checks = state.checks + 1
  if (checks >= MAX_CHECKS) {
    return escalate(job, { ...state, checks }, `it still did not pass after ${checks} attempts`)
  }
  await writeIntegration(job.root, { ...state, checks })
  return [
    ...why,
    '',
    `Nothing was committed. ${MAX_CHECKS - checks} more attempt(s) in this round before it stops for a person -- or call ss_done with integration: "abort".`,
  ].join('\n')
}

/**
 * The agent gives up. Whatever is in the checkout -- its edits, and anyone
 * else's made since -- is kept under a ref first; then the merge, if it is
 * the one ss_done started, is undone, and it stops for a person.
 */
async function abandon(job: Job, state: Integration | null, elsewhere: boolean): Promise<string> {
  if (!state) return `Nothing is being integrated for "${job.taskId}", so there is nothing to abort.`
  if (elsewhere) {
    await clearIntegration(job.root, job.taskId)
    return `Cleared a record of integrating ${state.branch} into ${state.contract}, which is not this task's. No commits were touched.`
  }
  if (state.phase === 'escalated') return escalated(job, state)
  let kept = state
  if (state.phase === 'merging') {
    const merging = await mergeHead(job.root)
    if (merging && merging === state.contractHead && (await currentBranch(job.root)) === state.branch) {
      kept = await save(job, state)
      // Not undone without a copy of what it would throw away.
      if (kept.savedRef) await abortMerge(job.root).catch(() => undefined)
    }
  }
  return escalate(job, kept, 'the agent could not resolve the conflict safely and stopped')
}

/** Keeps everything uncommitted in the checkout under a ref, if there is any. Never moves anything. */
async function save(job: Job, state: Integration): Promise<Integration> {
  if (state.savedRef) return state
  try {
    const ref = savedRef(job.slug, job.taskId, state.rounds)
    await snapshotWork(job.root, ref, OWN_ARTIFACTS, `session-share: uncommitted work on ${job.branch}, round ${state.rounds}`)
    return { ...state, savedRef: ref }
  } catch {
    return state
  }
}

/**
 * Stops for a person. Nothing is undone here: a merge in progress stays in
 * progress, with every edit where it was, and a copy of them is kept under a
 * ref besides. Stopped is stopped -- no call of ss_done gets past it until a
 * person has written in the room about this task (see resume).
 */
async function escalate(job: Job, state: Integration, reason: string): Promise<string> {
  const kept = (await mergeHead(job.root)) ? await save(job, state) : state
  const next: Integration = { ...kept, phase: 'escalated', reason, escalatedAt: Date.now() }
  await writeIntegration(job.root, next)
  // Best effort: the tool's own answer says the same, and must not fail because chat did.
  await runCommand(job.config, {
    type: 'chat.post',
    body: [
      `Integrating #${job.taskId} into ${job.contract} needs a person: ${reason}.`,
      `Conflicted: ${state.conflicts.join(', ') || 'none'}. Nothing untested was committed and nothing was landed; the work is on ${job.branch}${next.savedRef ? `, uncommitted edits kept at ${next.savedRef}` : ''}.`,
      `When you have decided how it should go, say so here mentioning #${job.taskId}, then tell its agent to run ss_done with integration: "retry".`,
    ].join('\n'),
    taskRef: job.taskId as never,
    asAgent: true,
    directive: false,
  }).catch(() => undefined)
  return escalated(job, next)
}

function escalated(job: Job, state: Integration): string {
  return [
    `Integrating "${job.taskId}" is stopped for a person: ${state.reason ?? 'it could not be resolved safely'}.`,
    'Nothing untested was committed and nothing was landed.',
    `Your work is on ${job.branch}; its commit from before any of this, ${state.original.slice(0, 7)}, is kept at ${backupRef(job.slug, job.taskId)}.`,
    ...(state.savedRef ? [`Every uncommitted edit in the checkout when it stopped is kept at ${state.savedRef}.`] : []),
    '',
    'Stop working on it. Do not resolve, commit, merge or reset anything for it, and do not ask to resume it',
    `or post in the room on a person's behalf. ss_done with integration: "retry" resumes only after a person`,
    `has written in the room about #${job.taskId} since it stopped; until then it refuses.`,
  ].join('\n')
}

/**
 * Resumes a stopped integration, which takes a person: a message from a
 * human in the room, about this task, written after it stopped. One message
 * resumes it once; stopping again needs another. The counts start again
 * then -- that is the person's call, not the agent's.
 */
async function resume(job: Job, state: Integration, snapshot: SessionSnapshot): Promise<Integration | null | string> {
  const since = state.escalatedAt ?? Infinity
  const said = (snapshot.chat ?? []).some(
    (message) =>
      message.authorKind === 'human' &&
      message.createdAt > since &&
      (message.taskRef === job.taskId || message.body.includes(`#${job.taskId}`)),
  )
  if (!said) {
    return [
      `Not resumed. Nobody has written in the room about #${job.taskId} since it stopped, and resuming is a person's decision.`,
      escalated(job, state),
    ].join('\n\n')
  }

  const { root } = job
  const [here, head, merging] = await Promise.all([currentBranch(root), revision(root, 'HEAD'), mergeHead(root)])
  const fresh = { reason: null, escalatedAt: null, rounds: 1, checks: 0, savedRef: null }
  if (here === state.branch && merging && merging === state.contractHead && head === state.taskHead) {
    // The merge is still there, edits and all: pick it up where it stopped.
    const next: Integration = { ...state, ...fresh, phase: 'merging', tested: null }
    await writeIntegration(root, next)
    return next
  }
  if (here === state.branch && !merging && head && state.tested && (await isAncestor(root, state.tested.sha, head))) {
    const next: Integration = { ...state, ...fresh, phase: 'tested' }
    await writeIntegration(root, next)
    return next
  }
  // Undone, or taken apart by hand: back to an ordinary finish, which integrates afresh if it has to.
  if (merging) {
    return `Not resumed: a merge of ${merging.slice(0, 7)} is in progress here that ss_done did not start. A person should finish or undo it (git status).`
  }
  await clearIntegration(root, job.taskId)
  return null
}

/**
 * Pushes the contract after a local merge. Nothing is merged here: if origin
 * has commits the merge lacks, someone landed in between, and what they
 * landed has to be put together with this task and tested on the task's
 * branch first -- so that is handed back as `moved`. A refusal with origin
 * where it was is tried again, a few times, and then given up on.
 */
async function publish(root: string, contract: string): Promise<'pushed' | { moved: string } | { error: string }> {
  let error = ''
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await push(root, contract)
      return 'pushed'
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure)
    }
    try {
      await gitFetch(root)
    } catch (failure) {
      return { error: failure instanceof Error ? failure.message : String(failure) }
    }
    const [upstream, local] = await Promise.all([revision(root, `refs/remotes/origin/${contract}`), revision(root, `refs/heads/${contract}`)])
    if (upstream && local && !(await isAncestor(root, upstream, local))) return { moved: upstream }
  }
  return { error }
}

/**
 * What a reported run is recorded against. A pass names exactly the commit
 * that ran, or is not recorded; a failure ships nothing, so it is recorded
 * whatever this checkout is at -- without asking origin anything, since a
 * broken thing has to be reportable when the network is not there.
 */
export async function verdictCommit(
  root: string,
  slug: string,
  passed: boolean,
): Promise<{ sha: string | null } | { problem: string }> {
  if (!passed) return { sha: null }
  try {
    return await assembledCommit(root, slug)
  } catch (error) {
    return { problem: `Could not tell which commit ran: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * The commit a run of the assembled thing is about, or why there is none to
 * speak of. A pass is recorded against it, so it has to be what actually ran:
 * this checkout at the contract branch, as committed, with nothing origin has
 * that it lacks.
 */
export async function assembledCommit(root: string, slug: string): Promise<{ sha: string } | { problem: string }> {
  const contract = contractBranch(slug)
  const sha = await revision(root, `refs/heads/${contract}`)
  if (!sha) return { problem: `There is no ${contract} in this checkout. Run ss_sync, check it out, run it, and report again.` }
  const head = await revision(root, 'HEAD')
  if (head !== sha) {
    return {
      problem: `This checkout is at ${head?.slice(0, 7) ?? 'no commit'}, not at ${contract} (${sha.slice(0, 7)}). A pass is recorded against the commit that ran: check out ${contract}, run it there, and report again.`,
    }
  }
  /**
   * Anything not ignored counts, untracked included: a stray source or config
   * file is part of what ran. What .gitignore covers -- builds, dependencies
   * -- is what running it makes, not a different revision.
   */
  const modified = (await changedFiles(root)).filter((path) => !OWN_ARTIFACTS.some((prefix) => path.startsWith(prefix)))
  if (modified.length > 0) {
    return {
      problem: [
        `Files here are not as ${contract} has them, so what ran is not that commit as committed:`,
        ...modified.slice(0, 10).map((path) => `  ${path}`),
        'Put them back or remove them (or ignore them, if they are build output), run it again, and report again.',
      ].join('\n'),
    }
  }
  if (await hasRemote(root)) {
    await gitFetch(root)
    const upstream = await revision(root, `refs/remotes/origin/${contract}`)
    if (upstream && !(await isAncestor(root, upstream, sha))) {
      return { problem: `origin/${contract} has commits this checkout does not. Run ss_sync, run it again on what is there now, and report that.` }
    }
  }
  return { sha }
}
