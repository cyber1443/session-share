import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { pathMatchesAny } from '@session-share/protocol'

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
    throw new GitError(`git ${args[0]} failed: ${summarize(failure.stderr ?? failure.message ?? '')}`, failure.stderr ?? '')
  }
}

/**
 * The line of stderr that says why. Git leads with progress and "To <url>"
 * lines, so the first line is usually the least informative one.
 */
function summarize(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^(To |From |hint:)/.test(line))
  const telling = lines.find((line) => /^(error|fatal|!|CONFLICT)/.test(line))
  return telling ?? lines[0] ?? 'no output'
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

/**
 * The branch work should be based on: the current one, or on a detached HEAD
 * the remote's default branch -- a session based on the literal `HEAD` would
 * branch every task from wherever this checkout happened to be pointing.
 */
export async function baseBranch(cwd: string): Promise<string> {
  const here = await currentBranch(cwd)
  if (here !== 'HEAD') return here
  try {
    const ref = await git(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
    return ref.replace(/^origin\//, '')
  } catch {
    return 'main'
  }
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
    await fastForward(cwd, branch)
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

/**
 * Brings the checked-out `branch` up to whatever origin has, when that is a
 * fast-forward. A teammate merging last leaves the local copy behind, and
 * pushing from behind is rejected. Diverged history is reported, not resolved.
 */
export async function fastForward(cwd: string, branch: string): Promise<void> {
  if (!(await hasRemote(cwd))) return
  await fetch(cwd)
  if (!(await remoteRefExists(cwd, branch))) return
  const [local, upstream] = await Promise.all([
    git(cwd, ['rev-parse', 'HEAD']),
    git(cwd, ['rev-parse', `origin/${branch}`]),
  ])
  if (await isAncestor(cwd, upstream, local)) return // up to date, or ahead
  if (!(await isAncestor(cwd, local, upstream))) {
    throw new GitError(
      `${branch} has diverged from origin/${branch}. Merge or rebase it by hand, then try again.`,
      '',
    )
  }
  // Behind and a fast-forward: if this fails, git's own reason is the true one.
  await git(cwd, ['merge', '--ff-only', `origin/${branch}`])
}

/** Is `origin/<branch>` known locally, as of the last fetch? */
export async function remoteRefExists(cwd: string, branch: string): Promise<boolean> {
  try {
    await git(cwd, ['rev-parse', '--verify', `refs/remotes/origin/${branch}`])
    return true
  } catch {
    return false
  }
}

/**
 * Updates the local `branch` to origin's without checking it out, so syncing
 * never moves someone off the branch they are working on. Fast-forward only.
 */
export async function updateLocalBranch(
  cwd: string,
  branch: string,
): Promise<'updated' | 'unchanged' | 'diverged' | 'no-remote'> {
  if (!(await hasRemote(cwd))) return 'no-remote'
  await fetch(cwd)
  if (!(await remoteRefExists(cwd, branch))) return 'no-remote'

  const remote = `origin/${branch}`
  if (!(await branchExists(cwd, branch))) {
    await git(cwd, ['branch', branch, remote])
    return 'updated'
  }
  if ((await currentBranch(cwd)) === branch) {
    const [head, upstream] = await Promise.all([
      git(cwd, ['rev-parse', 'HEAD']),
      git(cwd, ['rev-parse', remote]),
    ])
    if (await isAncestor(cwd, upstream, head)) return 'unchanged'
    if (!(await isAncestor(cwd, head, upstream))) return 'diverged'
    // A fast-forward that fails here fails for git's own reason; let it say so.
    await git(cwd, ['merge', '--ff-only', remote])
    return 'updated'
  }

  const [local, upstream] = await Promise.all([
    git(cwd, ['rev-parse', branch]),
    git(cwd, ['rev-parse', remote]),
  ])
  if (local === upstream) return 'unchanged'
  if (await isAncestor(cwd, upstream, local)) return 'unchanged' // local is ahead
  if (!(await isAncestor(cwd, local, upstream))) return 'diverged'

  /**
   * Moving the ref under a worktree that has it checked out leaves that tree's
   * index describing the old commit -- a staged reversal of whatever just
   * landed, waiting to be committed. There, it is fast-forwarded in place.
   */
  const here = resolve(await git(cwd, ['rev-parse', '--show-toplevel']))
  const elsewhere = (await listWorktrees(cwd)).find(
    (tree) => tree.branch === branch && resolve(tree.path) !== here,
  )
  if (elsewhere) {
    try {
      await git(elsewhere.path, ['merge', '--ff-only', remote])
      return 'updated'
    } catch (error) {
      throw new GitError(
        `${branch} is checked out at ${elsewhere.path} and could not be fast-forwarded there: ${(error as Error).message}`,
        '',
      )
    }
  }
  await git(cwd, ['update-ref', `refs/heads/${branch}`, upstream, local])
  return 'updated'
}

async function isAncestor(cwd: string, ancestor: string, of: string): Promise<boolean> {
  try {
    await git(cwd, ['merge-base', '--is-ancestor', ancestor, of])
    return true
  } catch {
    return false
  }
}

/**
 * Resolves a repo-relative path and refuses anything that lands outside the
 * repository. Contract files arrive from whoever proposed the split, and a
 * `../` there would otherwise write wherever a teammate chose.
 */
export function insideRepo(cwd: string, path: string): string {
  const root = resolve(cwd)
  const absolute = resolve(root, path)
  const rel = relative(root, absolute)
  if (isAbsolute(path) || rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Refusing to write "${path}": it is outside the repository.`)
  }
  /**
   * Any `.git` segment, in any case: macOS volumes ignore case, so `.GIT/config`
   * is `.git/config`, and a git config can name programs git will run. A nested
   * repository's `.git` is just as dangerous as the top one.
   */
  if (rel.split(/[\\/]/).some((segment) => segment.toLowerCase() === '.git')) {
    throw new Error(`Refusing to write "${path}" inside a .git directory.`)
  }
  return absolute
}

export async function writeFiles(
  cwd: string,
  files: Array<{ path: string; contents: string }>,
): Promise<string[]> {
  // Check all of them before writing any, so a bad path leaves nothing behind.
  const targets = files.map((file) => insideRepo(cwd, file.path))
  const written: string[] = []
  for (const [index, file] of files.entries()) {
    const absolute = targets[index]!
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, file.contents)
    written.push(file.path)
  }
  return written
}

/**
 * Every changed, added or deleted file in the working tree, repo-relative.
 * Untracked files are listed individually so globs can be matched against them.
 */
export async function changedFiles(cwd: string): Promise<string[]> {
  return (await statusEntries(cwd)).map((entry) => entry.path)
}

/**
 * Tracked changes -- staged or not -- that are not under `patterns`. Untracked
 * files ride along a checkout and a merge unharmed; these do not, and git stops
 * halfway through a merge because of them.
 */
export async function foreignChanges(cwd: string, patterns: string[], ignore: string[]): Promise<string[]> {
  return (await statusEntries(cwd))
    .filter((entry) => entry.status !== '??')
    .map((entry) => entry.path)
    .filter((path) => !pathMatchesAny(path, patterns) && !ignore.some((prefix) => path.startsWith(prefix)))
}

async function statusEntries(cwd: string): Promise<Array<{ status: string; path: string }>> {
  const { stdout } = await run('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd,
    timeout: 60_000,
    maxBuffer: 10 * 1024 * 1024,
  })
  const entries = stdout.split('\0')
  const files: Array<{ status: string; path: string }> = []
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!
    if (entry.length < 4) continue
    const status = entry.slice(0, 2)
    files.push({ status, path: entry.slice(3) })
    // A rename is followed by its source; the source is a deletion to commit too.
    if (status[0] === 'R' || status[0] === 'C') files.push({ status, path: entries[++i]! })
  }
  return files
}

/**
 * Commits exactly the changed files that fall under `patterns`, and nothing
 * else -- not even whatever the person had already staged for themselves.
 * Patterns are lease globs (braces, `**`), which git pathspecs do not speak,
 * so they are matched here. Returns null when there was nothing to commit.
 */
export async function commit(
  cwd: string,
  patterns: string[],
  message: string,
): Promise<string | null> {
  const files = (await changedFiles(cwd)).filter((file) => pathMatchesAny(file, patterns))
  if (files.length === 0) return null
  await git(cwd, ['add', '-A', '--', ...files])
  await git(cwd, ['commit', '--only', '-m', message, '--', ...files])
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
  } catch (error) {
    const conflicts = (await git(cwd, ['diff', '--name-only', '--diff-filter=U']))
      .split('\n')
      .filter(Boolean)
    await git(cwd, ['merge', '--abort']).catch(() => undefined)
    // Anything other than a conflict (a missing ref, a dirty tree) is not ours to dress up.
    if (conflicts.length === 0) throw error
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

/**
 * A second working tree of the same clone, so one repository can be in more
 * than one session at a time.
 *
 * The alternative -- one checkout per session -- means a second clone, a second
 * `npm install` and a second copy of everything ignored by git, for work that
 * shares all of it. A worktree is a directory and a branch; the object store
 * stays shared, so it is close to free.
 *
 * Each session still gets its own directory, which is what the lease gate and
 * the server's one-agent-per-path rule both require.
 */
export async function addWorktree(
  cwd: string,
  path: string,
  branch: string,
  from: string,
): Promise<'created' | 'existing'> {
  if (existsSync(path)) return 'existing'

  await fetch(cwd)
  const base = (await remoteBranchExists(cwd, from)) ? `origin/${from}` : from

  // The branch may already exist from an earlier worktree that was removed.
  const args = (await branchExists(cwd, branch))
    ? ['worktree', 'add', path, branch]
    : ['worktree', 'add', '-b', branch, path, base]

  await git(cwd, args)
  return 'created'
}

export interface Worktree {
  path: string
  branch: string | null
}

export async function listWorktrees(cwd: string): Promise<Worktree[]> {
  const output = await git(cwd, ['worktree', 'list', '--porcelain'])
  const trees: Worktree[] = []
  let current: Partial<Worktree> = {}

  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) current = { path: line.slice('worktree '.length) }
    else if (line.startsWith('branch ')) current.branch = line.slice('branch refs/heads/'.length)
    else if (line === '' && current.path) {
      trees.push({ path: current.path, branch: current.branch ?? null })
      current = {}
    }
  }
  if (current.path) trees.push({ path: current.path, branch: current.branch ?? null })
  return trees
}

/** Can we actually talk to origin with the credentials on this machine? */
export async function canPush(cwd: string): Promise<boolean> {
  try {
    await git(cwd, ['ls-remote', '--exit-code', 'origin', 'HEAD'])
    return true
  } catch {
    return false
  }
}
