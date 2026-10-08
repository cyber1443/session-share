import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'

/**
 * Session attachment lives in the repo, not in the plugin, because it is a
 * property of this checkout: which session, which participant, which server.
 * The hook, the MCP server and the slash commands are three separate processes
 * and this file is the only thing they share.
 */
export const SessionConfig = z.object({
  serverUrl: z.string().min(1),
  sessionRef: z.string().min(1),
  participantId: z.string().min(1),
  /**
   * Long-lived bearer token obtained by redeeming a one-time join code. Lives
   * here rather than in a shell command so it never reaches shell history.
   */
  participantToken: z.string().min(1).nullish(),
  githubLogin: z.string().min(1),
  displayName: z.string().min(1),
  repoPath: z.string().min(1),
})
export type SessionConfig = z.infer<typeof SessionConfig>

export const CONFIG_RELATIVE_PATH = join('.session-share', 'session.json')

/** Walks up from `cwd` so the hook works from any subdirectory of the repo. */
export function findConfigPath(startDir: string): string | null {
  let dir = resolve(startDir)
  for (;;) {
    const candidate = join(dir, CONFIG_RELATIVE_PATH)
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export function readConfig(startDir: string): SessionConfig | null {
  const path = findConfigPath(startDir)
  if (!path) return null
  try {
    return SessionConfig.parse(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return null
  }
}

export function writeConfig(repoPath: string, config: SessionConfig): string {
  const path = join(repoPath, CONFIG_RELATIVE_PATH)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  excludeFromGit(repoPath)
  return path
}

/**
 * The config holds a bearer token, so it must never be committed -- and one
 * `git add -A` is all that takes. `.git/info/exclude` keeps it out without
 * touching a tracked `.gitignore` that would then show up in everyone's diff.
 * Worktrees share the main checkout's exclude file, hence the common dir.
 */
export function excludeFromGit(repoPath: string): void {
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const exclude = join(isAbsolute(common) ? common : join(repoPath, common), 'info', 'exclude')
    const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''
    if (current.split('\n').some((line) => line.trim() === '.session-share/')) return
    mkdirSync(dirname(exclude), { recursive: true })
    appendFileSync(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}.session-share/\n`)
  } catch {
    // Not a git repository, or git is missing; nothing to protect from a commit.
  }
}
