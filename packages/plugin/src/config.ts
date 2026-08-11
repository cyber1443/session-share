import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`)
  return path
}
