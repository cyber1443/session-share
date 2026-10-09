'use client'

import { useState } from 'react'
import { api, type PullSummary } from '@/lib/api'

export function ago(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

const CHECKS: Record<string, { label: string; className: string }> = {
  SUCCESS: { label: 'checks pass', className: 'text-emerald-400' },
  FAILURE: { label: 'checks fail', className: 'text-red-400' },
  ERROR: { label: 'checks errored', className: 'text-red-400' },
  PENDING: { label: 'checks running', className: 'text-amber-400' },
  EXPECTED: { label: 'checks expected', className: 'text-amber-400' },
}

const REVIEW: Record<string, { label: string; className: string }> = {
  APPROVED: { label: 'approved', className: 'text-emerald-400' },
  CHANGES_REQUESTED: { label: 'changes requested', className: 'text-red-400' },
  REVIEW_REQUIRED: { label: 'review required', className: 'text-amber-400' },
}

/**
 * One pull request, with what someone needs to decide whether to merge it:
 * where it goes, how big it is, whether CI and GitHub are happy with it.
 * Merging takes two clicks, because it lands on a branch other people build on.
 */
export function PullCard({
  slug,
  pull,
  ticketTitle,
  onMerged,
}: {
  slug: string
  pull: PullSummary
  /** The board ticket this PR finishes, when there is one. */
  ticketTitle?: string | null
  onMerged?: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const [method, setMethod] = useState<'merge' | 'squash' | 'rebase'>('merge')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [merged, setMerged] = useState(false)

  const conflicting = pull.mergeable === 'CONFLICTING'
  const checks = pull.checks ? CHECKS[pull.checks] : null
  const review = pull.reviewDecision ? REVIEW[pull.reviewDecision] : null

  const merge = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.merge(slug, pull.number, method)
      setMerged(true)
      onMerged?.()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'merge failed')
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }

  return (
    <div className="panel space-y-2 p-3 text-xs">
      <div className="flex items-baseline gap-2">
        <a href={pull.url} target="_blank" rel="noreferrer" className="shrink-0 text-mute hover:text-neutral-300">
          #{pull.number}
        </a>
        <a
          href={pull.url}
          target="_blank"
          rel="noreferrer"
          className="min-w-0 flex-1 truncate text-neutral-200 hover:underline"
          title={pull.title}
        >
          {pull.title}
        </a>
        {pull.draft ? <span className="shrink-0 text-mute">draft</span> : null}
      </div>

      <p className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-neutral-300" title="the branch the changes come from">
          {pull.headRef}
        </span>
        <span className="text-mute">into</span>
        <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-accent" title="the branch it merges into">
          {pull.baseRef}
        </span>
      </p>

      <p className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-mute">
        <span>
          {pull.author} · opened {pull.createdAt ? ago(pull.createdAt) : '?'} · updated {ago(pull.updatedAt)}
        </span>
        {pull.commits !== undefined ? <span>{pull.commits} commit(s)</span> : null}
        {pull.changedFiles !== undefined ? <span>{pull.changedFiles} file(s)</span> : null}
        {pull.additions !== undefined ? (
          <span>
            <span className="text-emerald-400">+{pull.additions}</span>{' '}
            <span className="text-red-400">−{pull.deletions}</span>
          </span>
        ) : null}
        {checks ? <span className={checks.className}>{checks.label}</span> : null}
        {review ? <span className={review.className}>{review.label}</span> : null}
        {conflicting ? <span className="text-red-400">conflicts with {pull.baseRef}</span> : null}
        {pull.mergeable === 'UNKNOWN' ? <span>GitHub is still checking for conflicts</span> : null}
        {(pull.labels ?? []).map((label) => (
          <span key={label} className="rounded border border-edge px-1">
            {label}
          </span>
        ))}
      </p>

      {ticketTitle ? <p className="text-[10px] text-mute">finishes the ticket “{ticketTitle}”</p> : null}
      {pull.body ? (
        <p className="line-clamp-4 whitespace-pre-line break-words text-[11px] text-neutral-400">{pull.body}</p>
      ) : null}

      {merged ? (
        <p className="text-emerald-400">Merged into {pull.baseRef}.</p>
      ) : (
        <div className="flex items-center gap-2">
          {confirming ? (
            <>
              <select
                className="btn"
                value={method}
                onChange={(event) => setMethod(event.target.value as typeof method)}
                aria-label="merge method"
              >
                <option value="merge">merge commit</option>
                <option value="squash">squash</option>
                <option value="rebase">rebase</option>
              </select>
              <button className="btn btn-accent" disabled={busy} onClick={() => void merge()}>
                {busy ? 'merging…' : `confirm: merge into ${pull.baseRef}`}
              </button>
              <button className="btn" disabled={busy} onClick={() => setConfirming(false)}>
                cancel
              </button>
            </>
          ) : (
            <button
              className="btn"
              disabled={pull.draft || conflicting}
              title={pull.draft ? 'a draft cannot be merged' : conflicting ? 'resolve the conflicts first' : ''}
              onClick={() => setConfirming(true)}
            >
              merge
            </button>
          )}
        </div>
      )}
      {error ? <p className="text-red-400">{error}</p> : null}
    </div>
  )
}
