import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

export interface LocalIdentity {
  githubLogin: string
  displayName: string
  /** Where the name came from, so the UI can be honest about how sure it is. */
  source: 'override' | 'gh' | 'git' | 'system'
}

/**
 * Peer mode takes a participant's name from their own machine rather than from
 * an identity provider. `gh` is preferred because it is at least the account
 * they are actually authenticated as; git config and the OS username are
 * fallbacks so that a session can start without any setup at all.
 *
 * None of this is verified. In peer mode the invite is the credential and the
 * names exist so humans can tell each other apart.
 */
export async function localIdentity(): Promise<LocalIdentity> {
  /**
   * An explicit override, so one machine can hold two participants. Without it
   * both Claude Codes read the same `gh` account, the server correctly decides
   * they are the same person, and the leases never collide -- which makes a
   * local rehearsal silently prove nothing.
   */
  const override = process.env.SESSION_SHARE_LOGIN?.trim()
  if (override) {
    return {
      githubLogin: override,
      displayName: process.env.SESSION_SHARE_NAME?.trim() || titleCase(override),
      source: 'override',
    }
  }

  const fromGh = await tryGh()
  if (fromGh) return fromGh

  const login = (await gitConfig('user.name')) ?? process.env.USER ?? 'dev'
  const handle = login.trim().toLowerCase().replace(/\s+/g, '-')
  return {
    githubLogin: handle,
    displayName: login.trim(),
    source: (await gitConfig('user.name')) ? 'git' : 'system',
  }
}

async function tryGh(): Promise<LocalIdentity | null> {
  try {
    const { stdout } = await run('gh', ['api', 'user', '--jq', '{login: .login, name: .name}'], {
      timeout: 5000,
    })
    const parsed = JSON.parse(stdout) as { login?: string; name?: string | null }
    if (!parsed.login) return null
    return {
      githubLogin: parsed.login,
      displayName: parsed.name?.trim() || parsed.login,
      source: 'gh',
    }
  } catch {
    return null
  }
}

async function gitConfig(key: string): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['config', '--get', key], { timeout: 3000 })
    return stdout.trim() || null
  } catch {
    return null
  }
}

/** Absolute root of the repository containing `cwd`, or `cwd` if it is not one. */
export async function repoRoot(cwd: string): Promise<string> {
  try {
    const { stdout } = await run('git', ['rev-parse', '--show-toplevel'], { cwd, timeout: 3000 })
    return stdout.trim() || cwd
  } catch {
    return cwd
  }
}

/** `owner/name` parsed from the origin remote, when there is one. */
export async function repoRemote(
  cwd: string,
): Promise<{ owner: string; name: string; remoteUrl: string } | null> {
  try {
    const { stdout } = await run('git', ['remote', 'get-url', 'origin'], { cwd, timeout: 3000 })
    const remoteUrl = stdout.trim()
    const match = remoteUrl.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/)
    if (!match) return null
    return { owner: match[1]!, name: match[2]!, remoteUrl }
  } catch {
    return null
  }
}

export async function currentBranch(cwd: string): Promise<string> {
  try {
    const { stdout } = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      timeout: 3000,
    })
    return stdout.trim() || 'main'
  } catch {
    return 'main'
  }
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}
