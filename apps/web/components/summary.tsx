'use client'

import { useState } from 'react'
import { usageDay, type DailySummary, type SessionSnapshot } from '@session-share/protocol'
import type { Send } from '@/lib/live'
import { tokens } from '@/lib/tokens'
import { Stat } from './history'

/** Just enough markdown for a write-up: headings, bullets and bold. */
function Prose({ text }: { text: string }) {
  const inline = (line: string) =>
    line.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
      part.startsWith('**') && part.endsWith('**') ? (
        <strong key={i} className="text-neutral-200">
          {part.slice(2, -2)}
        </strong>
      ) : (
        part
      ),
    )
  return (
    <div className="space-y-1.5 leading-relaxed text-neutral-300">
      {text.split('\n').map((line, i) => {
        const heading = /^#{1,6}\s+(.*)$/.exec(line)
        if (heading) return <p key={i} className="pt-2 text-[10px] uppercase tracking-wider text-mute">{heading[1]}</p>
        const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
        if (bullet) return <p key={i} className="pl-3 -indent-3">· {inline(bullet[1]!)}</p>
        return line.trim() ? <p key={i}>{inline(line)}</p> : null
      })}
    </div>
  )
}

function SummaryCard({ summary, snapshot }: { summary: DailySummary; snapshot: SessionSnapshot }) {
  const { digest } = summary
  const writer = snapshot.participants.find((p) => p.id === summary.writerId)
  return (
    <article className="panel space-y-3 p-4">
      <header className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm text-neutral-200">{summary.day}</h3>
        <span className="text-[10px] text-mute">
          {summary.narrative
            ? `written by ${writer?.displayName ?? 'a Claude'}'s Claude`
            : writer
              ? `asked ${writer.displayName}'s Claude for a write-up…`
              : 'no Claude was open to write it up'}
        </span>
      </header>

      <div className="flex flex-wrap gap-2">
        <Stat label="opened" value={digest.opened.length} />
        <Stat label="shipped" value={digest.shipped.length} />
        <Stat label="tasks merged" value={digest.tasksMerged} />
        <Stat label="runs passed / failed" value={`${digest.verifiedPassed} / ${digest.verifiedFailed}`} />
        <Stat label="follow-ups" value={digest.followUps.length} />
      </div>

      {summary.narrative ? <Prose text={summary.narrative} /> : null}

      <div className="space-y-1 text-[11px] text-mute">
        {digest.shipped.length > 0 ? <p>Shipped: {digest.shipped.join(', ')}</p> : null}
        {digest.followUps.length > 0 ? <p>Found while verifying: {digest.followUps.join(', ')}</p> : null}
        {Object.keys(digest.columns).length > 0 ? (
          <p>
            Board: {Object.entries(digest.columns).map(([column, n]) => `${column} ${n}`).join(' · ')}
          </p>
        ) : null}
        {digest.spend.length > 0 ? (
          <p>Spend: {digest.spend.map((s) => `${s.login} ${tokens(s.units)}`).join(' · ')} units</p>
        ) : null}
      </div>
    </article>
  )
}

/**
 * One card per day: what the server counted, and the host's Claude's read of
 * where the project stands. Yesterday is written up on its own every day --
 * the counts at once, the write-up when a Claude is open; "summarize today"
 * asks for one now.
 */
export function SummaryView({ snapshot, send }: { snapshot: SessionSnapshot; send: Send }) {
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const summaries = [...snapshot.summaries].reverse()

  const ask = async () => {
    setError(null)
    setAsking(true)
    try {
      await send({ type: 'summary.request', day: usageDay(Date.now()) })
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'failed')
    } finally {
      setAsking(false)
    }
  }

  return (
    <div className="h-full overflow-y-auto p-4 text-xs">
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn btn-accent" onClick={() => void ask()} disabled={asking}>
          summarize today
        </button>
        <p className="text-mute">
          Written by the host&apos;s Claude, on the host&apos;s account. Every day after 00:00 UTC
          yesterday is summarized on its own if anything happened; with no Claude open, the counts are kept and
          the write-up follows when one opens.
        </p>
      </div>
      {error ? <p className="mt-2 text-red-400">{error}</p> : null}
      <div className="mt-4 max-w-3xl space-y-4">
        {summaries.map((summary) => (
          <SummaryCard key={summary.day} summary={summary} snapshot={snapshot} />
        ))}
        {summaries.length === 0 ? <p className="text-mute">No summaries yet.</p> : null}
      </div>
    </div>
  )
}
