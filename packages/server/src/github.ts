import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { RepoRef } from '@session-share/protocol'

const run = promisify(execFile)

export interface PullSummary {
  number: number
  title: string
  author: string
  url: string
  draft: boolean
  headRef: string
  baseRef: string
  updatedAt: string
}

export interface RunSummary {
  id: number
  workflow: string
  title: string
  branch: string
  event: string
  status: string
  conclusion: string | null
  url: string
  createdAt: string
}

export interface GitHubStatus {
  repo: string | null
  pulls: PullSummary[]
  runs: RunSummary[]
  /** Why nothing could be read, said plainly; null when it worked. */
  error: string | null
  fetchedAt: number
}

/** GitHub's own limit for anonymous reads is 60 an hour; a board polls. */
const TTL_MS = 60 * 1000

/**
 * Open pull requests and recent Actions runs for a session's repository, read
 * by the server so no browser ever holds a GitHub token.
 *
 * The token is the server's own: `GITHUB_TOKEN` (or `GH_TOKEN`) when one is
 * set, which is how a hosted server is configured, or else whatever `gh` on
 * this machine is signed in as, which is how a peer host already works. With
 * neither, public repositories still read, slowly.
 */
export class GitHubReader {
  private readonly cache = new Map<string, GitHubStatus>()
  private tokenPromise: Promise<string | null> | null = null

  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly tokenSource: () => Promise<string | null> = defaultToken,
  ) {}

  async status(repo: RepoRef): Promise<GitHubStatus> {
    if (!repo.owner || repo.owner === 'local') {
      return empty(null, 'This session has no GitHub remote, so there is nothing to show.')
    }
    const slug = `${repo.owner}/${repo.name}`
    const cached = this.cache.get(slug)
    if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached

    this.tokenPromise ??= this.tokenSource().catch(() => null)
    const token = await this.tokenPromise
    const get = async (path: string) => {
      const response = await this.fetcher(`https://api.github.com/repos/${slug}${path}`, {
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'session-share',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.timeout(8000),
      })
      if (!response.ok) {
        throw new Error(
          response.status === 404
            ? `GitHub does not show ${slug} to this server${token ? '' : ' (no token: sign in with gh, or set GITHUB_TOKEN)'}.`
            : `GitHub answered ${response.status}${response.status === 403 ? ' (rate limited or not allowed)' : ''}.`,
        )
      }
      return response.json() as Promise<unknown>
    }

    let status: GitHubStatus
    try {
      const [pulls, runs] = await Promise.all([
        get('/pulls?state=open&per_page=30&sort=updated&direction=desc') as Promise<RawPull[]>,
        get('/actions/runs?per_page=20') as Promise<{ workflow_runs: RawRun[] }>,
      ])
      status = {
        repo: slug,
        pulls: pulls.map((pull) => ({
          number: pull.number,
          title: pull.title,
          author: pull.user?.login ?? 'unknown',
          url: pull.html_url,
          draft: Boolean(pull.draft),
          headRef: pull.head?.ref ?? '',
          baseRef: pull.base?.ref ?? '',
          updatedAt: pull.updated_at,
        })),
        runs: (runs.workflow_runs ?? []).map((item) => ({
          id: item.id,
          workflow: item.name ?? 'workflow',
          title: item.display_title ?? item.head_commit?.message?.split('\n')[0] ?? '',
          branch: item.head_branch ?? '',
          event: item.event ?? '',
          status: item.status ?? 'unknown',
          conclusion: item.conclusion ?? null,
          url: item.html_url,
          createdAt: item.created_at,
        })),
        error: null,
        fetchedAt: Date.now(),
      }
    } catch (error) {
      // A failure is cached too, briefly, so a broken token is not retried per poll.
      status = empty(slug, error instanceof Error ? error.message : String(error))
    }
    this.cache.set(slug, status)
    return status
  }
}

interface RawPull {
  number: number
  title: string
  html_url: string
  draft?: boolean
  updated_at: string
  user?: { login?: string }
  head?: { ref?: string }
  base?: { ref?: string }
}

interface RawRun {
  id: number
  name?: string
  display_title?: string
  head_branch?: string
  head_commit?: { message?: string }
  event?: string
  status?: string
  conclusion?: string | null
  html_url: string
  created_at: string
}

const empty = (repo: string | null, error: string): GitHubStatus => ({
  repo,
  pulls: [],
  runs: [],
  error,
  fetchedAt: Date.now(),
})

async function defaultToken(): Promise<string | null> {
  const fromEnv = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim()
  if (fromEnv) return fromEnv
  try {
    const { stdout } = await run('gh', ['auth', 'token'], { timeout: 5000 })
    return stdout.trim() || null
  } catch {
    return null
  }
}
