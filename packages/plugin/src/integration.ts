import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { gitPath } from './git.js'

/**
 * A task's work meeting the contract branch, when git could not put the two
 * together on the contract branch by itself.
 *
 * Resolving a conflict is a judgement about what both sides meant, so it is
 * handed to the agent that holds the task -- inside its own checkout, on its
 * own branch, with the contract merged *into the task* rather than the other
 * way round. The contract branch everyone shares never holds a half-resolved
 * merge, and the task's commits are never rewritten: the merge only adds to
 * them, and the commit it started from is kept under a ref of its own.
 *
 * The merge is never committed by git. ss_done runs the task's acceptance
 * command on the exact candidate tree and commits that tree, and only that
 * tree, if it passes -- so no resolution exists as a commit that has not been
 * tested, and a test cannot vouch for a tree it did not run on.
 *
 * This file is the memory of that, so the next ss_done knows what it is in
 * the middle of. It lives in the git directory, never in the working tree,
 * and names the exact commits it is about: if the branch, its head or the
 * commit being merged in are not what it says, it is stale, and nothing is
 * landed on its strength.
 */
export interface Integration {
  version: 2
  slug: string
  taskId: string
  branch: string
  contract: string
  /** The task branch before any of this started, also kept at `backupRef`. */
  original: string
  /** The task branch head this round's merge began on. */
  taskHead: string
  /** The contract commit this round is merging in. */
  contractHead: string
  conflicts: string[]
  /** What git merged by itself, index path to mode and blob, at the stop. */
  auto: Record<string, string>
  /**
   * merging: a merge is in progress on the task branch, not committed.
   * tested: the round's merge was committed after its acceptance command
   * passed on exactly that tree; it is landing.
   * escalated: stopped for a person, see `reason`.
   */
  phase: 'merging' | 'tested' | 'escalated'
  /** What the last passing run was of: the commit made from it, its tree, and the command. */
  tested: { sha: string; tree: string; command: string } | null
  /** Conflicting merges started for this task, this one included. Only a person resets it. */
  rounds: number
  /** Failed attempts at this round: refusals and failing runs. Only a person resets it. */
  checks: number
  reason: string | null
  /** When it last stopped for a person; a resume has to come from after this. */
  escalatedAt: number | null
  /** Where the work in the checkout was kept when it stopped, if it was. */
  savedRef: string | null
  startedAt: number
}

/**
 * How far the agent is let go before a person is brought in. A fourth
 * conflicting round means the contract keeps moving under the same files --
 * a seam problem, not a typo -- and five failed attempts in one round mean
 * the agent is not converging.
 */
export const MAX_ROUNDS = 3
export const MAX_CHECKS = 5
/** The longest an acceptance command is let run inside ss_done. */
export const ACCEPTANCE_TIMEOUT_MS = 30 * 60_000

export const backupRef = (slug: string, taskId: string) => `refs/session-share/${slug}/${taskId}/original`
/** Where a merge into the contract that could not be published is kept. */
export const unpublishedRef = (slug: string, taskId: string) => `refs/session-share/${slug}/${taskId}/unpublished`
/** Where the checkout's uncommitted work is kept when a round is stopped or undone. */
export const savedRef = (slug: string, taskId: string, round: number) =>
  `refs/session-share/${slug}/${taskId}/attempt-${round}`

async function file(root: string, taskId: string): Promise<string> {
  return gitPath(root, `session-share/integration-${taskId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`)
}

/**
 * The record for a task, if any. One from an older plugin is returned as it
 * is, version and all, so it can be refused rather than mistaken for none.
 */
export async function readIntegration(root: string, taskId: string): Promise<Integration | { version: number; legacy: true } | null> {
  const path = await file(root, taskId)
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Integration
    if (parsed.taskId !== taskId) return null
    return parsed.version === 2 ? parsed : { version: Number(parsed.version) || 0, legacy: true }
  } catch {
    return { version: 0, legacy: true }
  }
}

export async function writeIntegration(root: string, state: Integration): Promise<void> {
  const path = await file(root, state.taskId)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`)
}

export async function clearIntegration(root: string, taskId: string): Promise<void> {
  rmSync(await file(root, taskId), { force: true })
}

export interface AcceptanceRun {
  passed: boolean
  exitCode: number
  /** The end of what it printed, for the report and for whoever fixes it. */
  output: string
}

/**
 * Runs a task's acceptance command, as the shell would, in `cwd`. Exit 0 is
 * a pass; anything else -- a failure, a signal, the time running out -- is not.
 */
export function runAcceptance(cwd: string, command: string, timeout = ACCEPTANCE_TIMEOUT_MS): Promise<AcceptanceRun> {
  return new Promise((resolve) => {
    execFile('/bin/sh', ['-c', command], { cwd, timeout, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      const output = `${stdout}${stderr}`.trim().slice(-1500)
      if (!error) return resolve({ passed: true, exitCode: 0, output })
      const code = (error as { code?: unknown }).code
      resolve({
        passed: false,
        exitCode: typeof code === 'number' ? code : -1,
        output: output || error.message.slice(-1500),
      })
    })
  })
}
