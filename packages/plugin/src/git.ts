import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message)
    this.name = 'GitError'
  }
}

/**
 * The git spine under a session.
 *
 * Branch names are derived, never invented per call, because two people on two
 * machines have to arrive at the same name without talking: the contract lives
 * on `ss/<session>/contract` and each task on `ss/<session>/<task-id>`.
 */
export const contractBranch = (slug: string) => `ss/${slug}/contract`
export const taskBranch = (slug: string, taskId: string) => `ss/${slug}/${taskId}`

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run('git', args, { cwd, timeout: 60_000, maxBuffer: 10 * 1024 * 1024 })
    return stdout.trim()
  } catch (error) {
    const failure = error as { stderr?: string; message?: string }
    throw new GitError(
      `git ${args[0]} failed: ${(failure.stderr ?? failure.message ?? '').trim().split('\n')[0]}`,
      failure.stderr ?? '',
    )
  }
}

export async function hasRemote(cwd: string): Promise<boolean> {
  try {
    await git(cwd, ['remote', 'get-url', 'origin'])
    return true
  } catch {
    return false
  }
}

export async function currentBranch(cwd: string): Promise<string> {
  return git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
}

/** Uncommitted changes, as porcelain lines. Empty means a clean tree. */
export async function dirtyFiles(cwd: string): Promise<string[]> {
  const output = await git(cwd, ['status', '--porcelain'])
  return output ? output.split('\n').map((line) => line.trim()) : []
}

export async function branchExists(cwd: string, branch: string): Promise<boolean> {
  try {
    await git(cwd, ['rev-parse', '--verify', `refs/heads/${branch}`])
    return true
  } catch {
    return false
  }
}

export async function remoteBranchExists(cwd: string, branch: string): Promise<boolean> {
  try {
    const output = await git(cwd, ['ls-remote', '--heads', 'origin', branch])
    return output.length > 0
  } catch {
    return false
  }
}

export async function fetch(cwd: string): Promise<void> {
  if (await hasRemote(cwd)) await git(cwd, ['fetch', 'origin', '--prune'])
}

/**
 * Checks out `branch`, creating it from `from` if it does not exist yet, and
 * preferring the remote copy when there is one -- otherwise the second person
 * to run this would branch from their own stale main.
 */
export async function checkoutBranch(
  cwd: string,
  branch: string,
  from: string,
): Promise<'created' | 'switched'> {
  if (await branchExists(cwd, branch)) {
    await git(cwd, ['checkout', branch])
    return 'switched'
  }

  await fetch(cwd)
  if (await remoteBranchExists(cwd, branch)) {
    await git(cwd, ['checkout', '-b', branch, `origin/${branch}`])
    return 'switched'
  }

  const base = (await remoteBranchExists(cwd, from)) ? `origin/${from}` : from
  await git(cwd, ['checkout', '-b', branch, base])
  return 'created'
}

export async function writeFiles(
  cwd: string,
  files: Array<{ path: string; contents: string }>,
): Promise<string[]> {
  const written: string[] = []
  for (const file of files) {
    const absolute = join(cwd, file.path)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, file.contents)
    written.push(file.path)
  }
  return written
}

/** Stages the given paths and commits. Returns null when there was nothing to commit. */
export async function commit(
  cwd: string,
  paths: string[],
  message: string,
): Promise<string | null> {
  await git(cwd, ['add', '--', ...paths])
  const staged = await git(cwd, ['diff', '--cached', '--name-only'])
  if (!staged) return null
  await git(cwd, ['commit', '-m', message])
  return git(cwd, ['rev-parse', 'HEAD'])
}

export async function push(cwd: string, branch: string): Promise<boolean> {
  if (!(await hasRemote(cwd))) return false
  await git(cwd, ['push', '-u', 'origin', branch])
  return true
}

export interface MergeResult {
  merged: boolean
  conflicts: string[]
}

/**
 * Merges `from` into `into`. On conflict the merge is aborted and the conflicting
 * paths are reported -- leaving someone's working tree mid-merge is a far worse
 * failure than telling them what collided.
 */
export async function mergeInto(cwd: string, into: string, from: string): Promise<MergeResult> {
  await git(cwd, ['checkout', into])
  try {
    await git(cwd, ['merge', '--no-ff', from, '-m', `Merge ${from} into ${into}`])
    return { merged: true, conflicts: [] }
  } catch {
    const conflicts = (await git(cwd, ['diff', '--name-only', '--diff-filter=U']))
      .split('\n')
      .filter(Boolean)
    await git(cwd, ['merge', '--abort']).catch(() => undefined)
    return { merged: false, conflicts }
  }
}

/** Opens a pull request with `gh`, returning its number, or null if gh cannot. */
export async function openPullRequest(
  cwd: string,
  options: { head: string; base: string; title: string; body: string; draft?: boolean },
): Promise<number | null> {
  try {
    const args = [
      'pr',
      'create',
      '--head',
      options.head,
      '--base',
      options.base,
      '--title',
      options.title,
      '--body',
      options.body,
    ]
    if (options.draft) args.push('--draft')
    const { stdout } = await run('gh', args, { cwd, timeout: 60_000 })
    const match = stdout.trim().match(/\/pull\/(\d+)/)
    return match ? Number(match[1]) : null
  } catch {
    // An existing PR, no gh, or no auth. None of these should stop the work.
    return null
  }
}

export async function existingPullRequest(cwd: string, head: string): Promise<number | null> {
  try {
    const { stdout } = await run('gh', ['pr', 'list', '--head', head, '--json', 'number'], {
      cwd,
      timeout: 30_000,
    })
    const parsed = JSON.parse(stdout) as Array<{ number: number }>
    return parsed[0]?.number ?? null
  } catch {
    return null
  }
}
