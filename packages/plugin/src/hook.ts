import { relative, resolve } from 'node:path'
import { readConfig } from './config.js'
import { runCommand } from './client.js'

/**
 * PreToolUse gate. Runs as a fresh process before every Edit/Write, so it has
 * one job and a hard latency budget: ask whether this file belongs to someone
 * else's task, and get out of the way.
 *
 * It fails OPEN. A coordination server that is down or slow must never stop a
 * developer from editing their own repository -- the cost of a missed check is
 * a merge conflict, the cost of a false block is a wedged session.
 */
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const TIMEOUT_MS = 1500

interface HookInput {
  tool_name?: string
  tool_input?: Record<string, unknown>
  cwd?: string
}

interface HookOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse'
    permissionDecision: 'allow' | 'deny' | 'ask'
    permissionDecisionReason: string
  }
}

export function extractPaths(toolInput: Record<string, unknown> | undefined): string[] {
  if (!toolInput) return []
  const paths: string[] = []
  for (const key of ['file_path', 'notebook_path', 'path']) {
    const value = toolInput[key]
    if (typeof value === 'string' && value.length > 0) paths.push(value)
  }
  return paths
}

/** Repo-relative, because that is the shape every ownedPaths glob is written in. */
export function toRepoRelative(repoPath: string, cwd: string, filePath: string): string {
  const absolute = resolve(cwd, filePath)
  return relative(repoPath, absolute).split('\\').join('/')
}

export async function decide(input: HookInput): Promise<HookOutput | null> {
  if (!input.tool_name || !EDIT_TOOLS.has(input.tool_name)) return null

  const cwd = input.cwd ?? process.cwd()
  const config = readConfig(cwd)
  if (!config) return null // not attached to a session; nothing to enforce

  const paths = extractPaths(input.tool_input)
    .map((p) => toRepoRelative(config.repoPath, cwd, p))
    .filter((p) => p.length > 0 && !p.startsWith('..'))
  if (paths.length === 0) return null

  let result
  try {
    result = await runCommand(config, { type: 'lease.check', paths }, TIMEOUT_MS)
  } catch (error) {
    process.stderr.write(
      `[session-share] lease check skipped: ${error instanceof Error ? error.message : error}\n`,
    )
    return null // fail open
  }

  if (result.allowed) return null

  const reason = result.denials.map((denial) => denial.message).join('\n')
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

const isEntrypoint = process.argv[1]?.endsWith('hook.js') ?? false

if (isEntrypoint) {
  const raw = await readStdin()
  let input: HookInput = {}
  try {
    input = JSON.parse(raw) as HookInput
  } catch {
    process.exit(0) // unparseable input is not a reason to block an edit
  }

  const output = await decide(input)
  if (output) process.stdout.write(JSON.stringify(output))
  process.exit(0)
}
