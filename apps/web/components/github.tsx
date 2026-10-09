'use client'

import type { SessionSnapshot } from '@session-share/protocol'
import { api } from '@/lib/api'
import { PullCard, ago as agoIso } from './pull'
import { usePoll } from '@/lib/poll'

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
export function GitHubView({ slug, snapshot }: { slug: string; snapshot: SessionSnapshot }) {
  const { data, error, reload } = usePoll(() => api.github(slug), 60_000, slug)

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
        <p className="text-[10px] text-mute">updated {agoIso(new Date(data.fetchedAt).toISOString())}</p>
      </div>
      {data.error ? <p className="mt-3 text-amber-400">{data.error}</p> : null}

      <p className="mt-5 text-[10px] uppercase tracking-wider text-mute">
        Open pull requests · {data.pulls.length}
      </p>
      <div className="mt-2 space-y-2">
        {data.pulls.length === 0 && !data.error ? <p className="text-mute">None open.</p> : null}
        {data.pulls.map((pull) => (
          <PullCard
            key={pull.number}
            slug={slug}
            pull={pull}
            ticketTitle={snapshot.tickets.find((t) => t.prNumber === pull.number)?.title ?? null}
            onMerged={reload}
          />
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
              <span className="shrink-0 text-mute">{agoIso(item.createdAt)}</span>
            </a>
          )
        })}
      </div>
    </div>
  )
}
