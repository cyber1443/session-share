import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { SessionSnapshot } from '@session-share/protocol'
import { runCommand } from './client.js'
import type { SessionConfig } from './config.js'
import {
  checkoutBranch,
  commit,
  contractBranch,
  dirtyFiles,
  existingPullRequest,
  fetch as gitFetch,
  hasRemote,
  mergeInto,
  openPullRequest,
  push,
  taskBranch,
  writeFiles,
} from './git.js'
import { describePreferences, readPreferences, writePreferences, PREFERENCES_FILE } from './preferences.js'

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
        'Read or change how session-share touches this machine: when work is committed, whether branches are pushed, whether pull requests are opened, and whether hosting is reachable on the local network.',
      inputSchema: {
        commitPolicy: z.enum(['explicit', 'auto-on-green']).nullish(),
        push: z.boolean().nullish(),
        openPullRequests: z.boolean().nullish(),
        expose: z.enum(['lan', 'loopback']).nullish(),
      },
    },
    async (input) => {
      const update: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(input)) {
        if (value !== null && value !== undefined) update[key] = value
      }

      const preferences =
        Object.keys(update).length > 0
          ? writePreferences({ ...update, configured: true })
          : readPreferences()

      return ctx.text(
        `${describePreferences(preferences)}\n\nStored in ${PREFERENCES_FILE}.${
          preferences.configured ? '' : '\n\nThese are defaults; nothing has been chosen yet.'
        }`,
      )
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

      if (!state.decomposition) throw new Error('There is no decomposition yet. Run /ss:plan first.')
      if (state.decomposition.status !== 'approved') {
        throw new Error('The split has not been approved yet. Approve it on the board first.')
      }
      if (state.session.phase !== 'plan') {
        return ctx.text(`The contract already landed on ${state.session.contractBranch}.`)
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
      await checkoutBranch(root, branch, state.session.repo.baseBranch)

      const written = await writeFiles(root, state.decomposition.contract.files)
      const sha = await commit(
        root,
        written,
        `contract: ${state.session.title}\n\n${state.decomposition.contract.summary}`,
      )

      const pushed = preferences.push ? await push(root, branch) : false

      let prNumber: number | null = null
      if (preferences.openPullRequests && pushed) {
        prNumber =
          (await existingPullRequest(root, branch)) ??
          (await openPullRequest(root, {
            head: branch,
            base: state.session.repo.baseBranch,
            title: state.session.title,
            body: `${state.decomposition.contract.summary}\n\nTasks land on this branch as they finish.`,
            draft: true,
          }))
      }

      await runCommand(config, {
        type: 'contract.committed',
        branch,
        commitSha: sha ?? 'unchanged',
        prNumber,
      })

      return ctx.text(
        [
          `Contract landed on ${branch}.`,
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
        'Finish a task: commit everything under its owned paths, push, open a pull request, and merge it into the contract branch so whatever was waiting on it becomes claimable.',
      inputSchema: {
        taskId: z.string(),
        summary: z.string().max(500).describe('One line for the commit message'),
        force: z
          .boolean()
          .default(false)
          .describe('Land it even though the acceptance command has not passed'),
      },
    },
    async ({ taskId, summary, force }) => {
      const config = ctx.config()
      const root = await ctx.repoRoot()
      const preferences = readPreferences()
      const state = await ctx.snapshot(config)

      const task = state.tasks.find((t) => t.id === taskId)
      if (!task) throw new Error(`No task "${taskId}" in this session.`)
      if (task.ownerId !== config.participantId) throw new Error(`You do not hold "${taskId}".`)

      /**
       * A task is done when the command that proves it passes. Landing on an
       * agent's say-so instead would make the acceptance criterion decorative,
       * and the whole split rests on each piece being independently provable.
       */
      if (!force && !task.lastTest?.passed) {
        return ctx.text(
          [
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
            .join('\n'),
        )
      }

      const branch = taskBranch(state.session.slug, taskId)
      const contract = contractBranch(state.session.slug)

      await checkoutBranch(root, branch, contract)
      const sha = await commit(root, task.ownedPaths, `${taskId}: ${summary}`)

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
       * their task as far as the session is concerned.
       */
      if (preferences.push) {
        await gitFetch(root)
        const caughtUp = await mergeInto(root, contract, `origin/${contract}`)
        if (!caughtUp.merged) {
          await checkoutBranch(root, branch, contract)
          return ctx.text(
            [
              `${contract} has moved on and cannot be fast-forwarded here:`,
              ...caughtUp.conflicts.map((path) => `  ${path}`),
              '',
              'Run /ss:sync, resolve that, then finish again.',
            ].join('\n'),
          )
        }
      }

      const merge = await mergeInto(root, contract, branch)
      if (!merge.merged) {
        await checkoutBranch(root, branch, contract)
        return ctx.text(
          [
            `Committed${sha ? ` (${sha.slice(0, 7)})` : ''} and pushed, but the merge into ${contract} conflicts:`,
            ...merge.conflicts.map((path) => `  ${path}`),
            '',
            'The merge was aborted, so nothing is half-applied and you are back on your branch.',
            'A conflict here means two tasks touched the same file, which the split was supposed to prevent —',
            'say so in chat before resolving it, because the seam is probably in the wrong place.',
          ].join('\n'),
        )
      }

      if (preferences.push) await push(root, contract)
      const { unblocked } = await runCommand(config, { type: 'task.merged', taskId: taskId as never })
      await checkoutBranch(root, contract, state.session.repo.baseBranch)

      return ctx.text(
        [
          `${taskId} is merged into ${contract}.`,
          sha ? `  commit ${sha.slice(0, 7)}` : '  nothing new to commit',
          prNumber ? `  PR #${prNumber}` : '',
          pushed ? '  pushed' : '  not pushed',
          '',
          unblocked.length > 0
            ? `Unblocked: ${unblocked.join(', ')}. Run /ss:next to take one.`
            : 'Nothing was waiting on it. Run /ss:next for whatever is ready.',
        ]
          .filter(Boolean)
          .join('\n'),
      )
    },
  )

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

      if (!(await hasRemote(root))) return ctx.text('No origin remote, so there is nothing to sync.')

      await gitFetch(root)
      const merge = await mergeInto(root, contract, `origin/${contract}`)
      return ctx.text(
        merge.merged
          ? `${contract} is up to date with origin.`
          : `Could not fast-forward ${contract}: ${merge.conflicts.join(', ')}`,
      )
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
      if (preferences.push) await push(root, contract)

      const body = [
        state.decomposition?.contract.summary ?? '',
        '',
        '## What landed',
        ...state.tasks.map((task) => `- **${task.id}** — ${task.title} (\`${task.acceptance.testCommand}\`)`),
      ].join('\n')

      const prNumber =
        (await existingPullRequest(root, contract)) ??
        (await openPullRequest(root, {
          head: contract,
          base: state.session.repo.baseBranch,
          title: state.session.title,
          body,
        }))

      return ctx.text(
        prNumber
          ? `PR #${prNumber}: ${state.session.title} — ${state.tasks.length} tasks, ${contract} → ${state.session.repo.baseBranch}.`
          : `Everything is merged into ${contract}. Open the PR yourself; gh could not (not installed, not authenticated, or no remote).`,
      )
    },
  )
}
