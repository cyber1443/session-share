/**
 * One way of committing and branching for every agent in a session. Several
 * Claudes writing into one contract branch read as one author only if they
 * all follow the same rules, and history made of "wip" and "fix stuff" is
 * history nobody can bisect.
 */

export const COMMIT_TYPES = ['feat', 'fix', 'refactor', 'perf', 'test', 'docs', 'build', 'ci', 'chore', 'style', 'revert'] as const

const SUBJECT_MAX = 72
const CONVENTIONAL = new RegExp(`^(${COMMIT_TYPES.join('|')})(\\([a-z0-9._/-]+\\))?!?: \\S.*$`)

/** Why a commit subject breaks the convention, or null when it follows it. */
export function subjectProblem(subject: string): string | null {
  if (!CONVENTIONAL.test(subject)) {
    return `"${subject}" is not a Conventional Commit. Use "<type>(<scope>): <subject>", type one of ${COMMIT_TYPES.join(', ')}.`
  }
  if (subject.length > SUBJECT_MAX) return `"${subject}" is longer than ${SUBJECT_MAX} characters.`
  if (subject.endsWith('.')) return `"${subject}" ends with a period.`
  return null
}

/**
 * A subject for a task's commit. A summary already in the convention is kept;
 * anything else is filed as a feature scoped to the task.
 */
export function taskSubject(taskId: string, summary: string): string {
  const line = summary.split('\n')[0]!.trim().replace(/\.$/, '')
  if (CONVENTIONAL.test(line)) return line.slice(0, SUBJECT_MAX)
  const subject = `feat(${taskId}): ${line.charAt(0).toLowerCase()}${line.slice(1)}`
  return subject.length > SUBJECT_MAX ? subject.slice(0, SUBJECT_MAX).trimEnd() : subject
}

/** The trailer that ties a commit to its task, so `git log --grep` finds a task's work. */
export const taskTrailer = (taskId: string) => `Task: ${taskId}`

/** The full message for a task's commit: subject, optional body, trailer. */
export function taskMessage(taskId: string, subject: string, body?: string): string {
  return [subject, body?.trim() ? body.trim() : null, taskTrailer(taskId)].filter(Boolean).join('\n\n')
}

/** Told to every agent in a session at start, beside the reply style. */
export const GIT_CONVENTIONS = [
  'session-share git rules for this repository:',
  'Branches are made by the session tools only: the contract lives on ss/<session>/contract and each task on ss/<session>/<task-id>. Do not create, rename or switch to other branches, and never commit on the contract or base branch directly.',
  'Commits are atomic: one logical change each, staged by explicit path (no `git add -A`, `git add .` or `git commit -a`). Unrelated changes go in separate commits.',
  `Messages are Conventional Commits: "<type>(<scope>): <subject>", type one of ${COMMIT_TYPES.join(', ')}; imperative, lowercase, no period, at most ${SUBJECT_MAX} characters. Use the task id as the scope.`,
  'Finish with ss_done; pass `commits` to land several atomic commits instead of one.',
].join(' ')

/** The first `-m`/`--message` argument of a shell command, if it has one. */
function messageOf(command: string): string | null {
  const match = /(?:^|\s)(?:-m|--message)(?:=|\s+)("((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))/.exec(command)
  if (!match) return null
  return (match[2] ?? match[3] ?? match[4] ?? '').replace(/\\"/g, '"')
}

/**
 * Why a shell command breaks the session's git rules, or null when it does
 * not. Only plain invocations are judged: anything this cannot parse is let
 * through, since a false block wedges a session and a missed one costs a
 * reworded commit.
 */
export function gitCommandProblem(command: string): string | null {
  for (const part of command.split(/&&|\|\||;|\n/)) {
    const words = part.trim().split(/\s+/)
    const at = words.indexOf('git')
    if (at === -1) continue
    // Global options come before the verb; -c and -C take a value.
    let i = at + 1
    while (i < words.length && words[i]!.startsWith('-')) i += words[i] === '-c' || words[i] === '-C' ? 2 : 1
    const [verb, ...rest] = words.slice(i)
    const args = rest.join(' ')

    if (verb === 'add' && /(^|\s)(-A|--all|\.|:\/)(\s|$)/.test(args)) {
      return 'Stage files by explicit path so each commit holds one logical change; `git add -A` and `git add .` sweep in everything.'
    }
    if (verb === 'commit') {
      if (/(^|\s)(-a|--all|-am|-[a-z]*a[a-z]*m)(\s|$)/.test(args)) {
        return 'Stage by path and commit without -a, so each commit holds one logical change.'
      }
      const message = messageOf(part)
      if (message !== null) {
        const problem = subjectProblem(message.split('\n')[0]!.trim())
        if (problem) return problem
      }
    }
    const created =
      (verb === 'checkout' && /(^|\s)-[bB](\s|$)/.test(args) && rest[rest.findIndex((w) => /^-[bB]$/.test(w)) + 1]) ||
      (verb === 'switch' && /(^|\s)(-c|-C|--create)(\s|$)/.test(args) && rest[rest.findIndex((w) => /^(-c|-C|--create)$/.test(w)) + 1]) ||
      (verb === 'branch' && rest.length > 0 && !rest[0]!.startsWith('-') && rest[0])
    if (created && !created.startsWith('ss/')) {
      return `Branches belong to the session tools (ss/<session>/<task-id>); "${created}" would be off the session's branching. Use ss_claim or ss_worktree instead.`
    }
  }
  return null
}
