'use client'

import { api } from '@/lib/api'
import { usePoll } from '@/lib/poll'

function ago(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function runTone(status: string, conclusion: string | null): { label: string; className: string } {
  if (status !== 'completed') return { label: status.replace('_', ' '), className: 'text-amber-400' }
  if (conclusion === 'success') return { label: 'passed', className: 'text-emerald-400' }
  if (conclusion === 'failure' || conclusion === 'timed_out') {
    return { label: conclusion.replace('_', ' '), className: 'text-red-400' }
  }
  return { label: conclusion ?? 'done', className: 'text-mute' }
}

/**
 * The repository as GitHub sees it: what is waiting for review and whether CI
 * is green. Read by the server with its own GitHub sign-in, once a minute.
 */
export function GitHubView({ slug }: { slug: string }) {
  const { data, error } = usePoll(() => api.github(slug), 60_000, slug)

  if (!data) {
    return <p className="p-6 text-xs text-mute">{error ? `Could not reach GitHub: ${error}` : 'asking GitHub…'}</p>
  }

  return (
    <div className="h-full overflow-y-auto p-4 text-xs">
      <div className="flex items-baseline justify-between">
        <p className="text-neutral-300">
          {data.repo ? (
            <a className="underline" href={`https://github.com/${data.repo}`} target="_blank" rel="noreferrer">
              {data.repo}
            </a>
          ) : (
            'no repository'
          )}
        </p>
        <p className="text-[10px] text-mute">updated {ago(new Date(data.fetchedAt).toISOString())}</p>
      </div>
      {data.error ? <p className="mt-3 text-amber-400">{data.error}</p> : null}

      <p className="mt-5 text-[10px] uppercase tracking-wider text-mute">
        Open pull requests · {data.pulls.length}
      </p>
      <div className="mt-2 space-y-1">
        {data.pulls.length === 0 && !data.error ? <p className="text-mute">None open.</p> : null}
        {data.pulls.map((pull) => (
          <a
            key={pull.number}
            href={pull.url}
            target="_blank"
            rel="noreferrer"
            className="panel flex items-baseline gap-3 px-3 py-2 hover:border-neutral-500"
          >
            <span className="w-10 shrink-0 text-mute">#{pull.number}</span>
            <span className="min-w-0 flex-1 truncate text-neutral-200">
              {pull.title}
              {pull.draft ? <span className="ml-2 text-mute">draft</span> : null}
            </span>
            <span className="hidden shrink-0 truncate text-mute md:inline">
              {pull.headRef} → {pull.baseRef}
            </span>
            <span className="shrink-0 text-mute">
              {pull.author} · {ago(pull.updatedAt)}
            </span>
          </a>
        ))}
      </div>

      <p className="mt-6 text-[10px] uppercase tracking-wider text-mute">Recent Actions runs</p>
      <div className="mt-2 space-y-1">
        {data.runs.length === 0 && !data.error ? (
          <p className="text-mute">No workflow runs. Add a workflow under .github/workflows to see CI here.</p>
        ) : null}
        {data.runs.map((item) => {
          const tone = runTone(item.status, item.conclusion)
          return (
            <a
              key={item.id}
              href={item.url}
              target="_blank"
              rel="noreferrer"
              className="panel flex items-baseline gap-3 px-3 py-2 hover:border-neutral-500"
            >
              <span className={`w-20 shrink-0 ${tone.className}`}>{tone.label}</span>
              <span className="w-24 shrink-0 truncate text-mute">{item.workflow}</span>
              <span className="min-w-0 flex-1 truncate text-neutral-200">{item.title}</span>
              <span className="hidden shrink-0 truncate text-mute md:inline">{item.branch}</span>
              <span className="shrink-0 text-mute">{ago(item.createdAt)}</span>
            </a>
          )
        })}
      </div>
    </div>
  )
}
