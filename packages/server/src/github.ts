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
  /** The branch the changes come from. */
  headRef: string
  /** The branch they would be merged into. */
  baseRef: string
  updatedAt: string
  createdAt?: string
  /** The rest only come back when the server has a token (one GraphQL query). */
  body?: string
  additions?: number
  deletions?: number
  changedFiles?: number
  commits?: number
  /** MERGEABLE, CONFLICTING or UNKNOWN (GitHub is still working it out). */
  mergeable?: string
  /** APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, or null when no review is needed. */
  reviewDecision?: string | null
  /** SUCCESS, FAILURE, PENDING, ERROR -- the combined state of the head commit's checks. */
  checks?: string | null
  labels?: string[]
}

export interface MergeResult {
  merged: boolean
  sha: string | null
  message: string
}

export interface PullHead {
  number: number
  open: boolean
  headSha: string
  headRef: string
  /** `owner/name` of the repository the head branch is in; another one for a fork. */
  headRepo: string | null
  baseRef: string
  baseRepo: string | null
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

    const token = await this.token()
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
      const [detailed, runs] = await Promise.all([
        token ? this.detailedPulls(repo, token).catch(() => null) : Promise.resolve(null),
        get('/actions/runs?per_page=20') as Promise<{ workflow_runs: RawRun[] }>,
      ])
      const pulls =
        detailed ??
        ((await get('/pulls?state=open&per_page=30&sort=updated&direction=desc')) as RawPull[]).map(fromRest)
      status = {
        repo: slug,
        pulls,
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

  private async token(): Promise<string | null> {
    this.tokenPromise ??= this.tokenSource().catch(() => null)
    return this.tokenPromise
  }

  /** Everything the board shows about each open pull request, in one request. */
  private async detailedPulls(repo: RepoRef, token: string): Promise<PullSummary[]> {
    const query = `query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        pullRequests(states: OPEN, first: 30, orderBy: {field: UPDATED_AT, direction: DESC}) {
          nodes {
            number title url isDraft body createdAt updatedAt
            author { login }
            headRefName baseRefName additions deletions changedFiles
            commits { totalCount }
            mergeable reviewDecision
            labels(first: 5) { nodes { name } }
            statusCommits: commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
          }
        }
      }
    }`
    const response = await this.fetcher('https://api.github.com/graphql', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'user-agent': 'session-share' },
      body: JSON.stringify({ query, variables: { owner: repo.owner, name: repo.name } }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`)
    const payload = (await response.json()) as {
      data?: { repository?: { pullRequests?: { nodes?: RawGraphPull[] } } }
      errors?: Array<{ message: string }>
    }
    const nodes = payload.data?.repository?.pullRequests?.nodes
    if (!nodes) throw new Error(payload.errors?.[0]?.message ?? 'no pull requests in the answer')
    return nodes.map((pull) => ({
      number: pull.number,
      title: pull.title,
      author: pull.author?.login ?? 'unknown',
      url: pull.url,
      draft: pull.isDraft,
      headRef: pull.headRefName,
      baseRef: pull.baseRefName,
      updatedAt: pull.updatedAt,
      createdAt: pull.createdAt,
      body: (pull.body ?? '').slice(0, 600),
      additions: pull.additions,
      deletions: pull.deletions,
      changedFiles: pull.changedFiles,
      commits: pull.commits?.totalCount,
      mergeable: pull.mergeable,
      reviewDecision: pull.reviewDecision ?? null,
      checks: pull.statusCommits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null,
      labels: (pull.labels?.nodes ?? []).map((label) => label.name),
    }))
  }

  /**
   * Merges a pull request with the server's own GitHub sign-in. GitHub still
   * enforces everything it would for a person: branch protection, required
   * reviews and checks, and whether that account may write at all.
   */
  async merge(
    repo: RepoRef,
    number: number,
    method: 'merge' | 'squash' | 'rebase',
    /** The head commit the merge was cleared for. GitHub refuses if the branch has moved since. */
    sha: string,
  ): Promise<MergeResult> {
    const token = await this.token()
    if (!token) {
      return { merged: false, sha: null, message: 'This server has no GitHub sign-in: run `gh auth login` on the host, or set GITHUB_TOKEN.' }
    }
    const response = await this.fetcher(`https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${number}/merge`, {
      method: 'PUT',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'user-agent': 'session-share',
      },
      body: JSON.stringify({ merge_method: method, sha }),
      signal: AbortSignal.timeout(20_000),
    })
    const payload = (await response.json().catch(() => ({}))) as { merged?: boolean; sha?: string; message?: string }
    this.cache.delete(`${repo.owner}/${repo.name}`)
    return {
      merged: response.ok && Boolean(payload.merged),
      sha: payload.sha ?? null,
      message: payload.message ?? (response.ok ? 'Merged.' : `GitHub answered ${response.status}.`),
    }
  }

  /**
   * A pull request as GitHub has it now: where it comes from, where it goes
   * and the commit at its head. Never cached -- this is what a merge is
   * checked against. Null when GitHub could not be asked or does not know it.
   */
  async pull(repo: RepoRef, number: number): Promise<PullHead | null> {
    const token = await this.token()
    try {
      const response = await this.fetcher(`https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${number}`, {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'session-share',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.timeout(8000),
      })
      if (!response.ok) return null
      const pull = (await response.json()) as {
        state?: string
        merged?: boolean
        head?: { sha?: string; ref?: string; repo?: { full_name?: string } | null }
        base?: { ref?: string; repo?: { full_name?: string } | null }
      }
      if (!pull.head?.sha || !pull.head.ref || !pull.base?.ref) return null
      return {
        number,
        open: pull.state === 'open' && !pull.merged,
        headSha: pull.head.sha,
        headRef: pull.head.ref,
        headRepo: pull.head.repo?.full_name ?? null,
        baseRef: pull.base.ref,
        baseRepo: pull.base.repo?.full_name ?? null,
      }
    } catch {
      return null
    }
  }

  /** Whether a pull request has been merged, for tickets whose PR was merged on GitHub. */
  async mergedState(repo: RepoRef, number: number): Promise<{ merged: boolean; sha: string | null } | null> {
    const token = await this.token()
    try {
      const response = await this.fetcher(`https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${number}`, {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'session-share',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.timeout(8000),
      })
      if (!response.ok) return null
      const pull = (await response.json()) as { merged?: boolean; merge_commit_sha?: string | null }
      return { merged: Boolean(pull.merged), sha: pull.merge_commit_sha ?? null }
    } catch {
      return null
    }
  }
}

interface RawGraphPull {
  number: number
  title: string
  url: string
  isDraft: boolean
  body: string | null
  createdAt: string
  updatedAt: string
  author: { login: string } | null
  headRefName: string
  baseRefName: string
  additions: number
  deletions: number
  changedFiles: number
  commits: { totalCount: number } | null
  mergeable: string
  reviewDecision: string | null
  labels: { nodes: Array<{ name: string }> } | null
  statusCommits: { nodes: Array<{ commit: { statusCheckRollup: { state: string } | null } }> } | null
}

const fromRest = (pull: RawPull): PullSummary => ({
  number: pull.number,
  title: pull.title,
  author: pull.user?.login ?? 'unknown',
  url: pull.html_url,
  draft: Boolean(pull.draft),
  headRef: pull.head?.ref ?? '',
  baseRef: pull.base?.ref ?? '',
  updatedAt: pull.updated_at,
})

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
