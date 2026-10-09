'use client'

import { useMemo, useState } from 'react'
import type { SessionSnapshot } from '@session-share/protocol'
import { api, type UsageDay } from '@/lib/api'
import { usePoll } from '@/lib/poll'
import { tokens } from '@/lib/tokens'
import { Stat } from './history'

const BAR = [
  'bg-emerald-400',
  'bg-sky-400',
  'bg-amber-400',
  'bg-violet-400',
  'bg-rose-400',
  'bg-teal-400',
  'bg-orange-400',
  'bg-indigo-400',
]

/**
 * How much each kind of token counts towards someone's share. A subscription
 * has no per-token price, so these are the API's price ratios relative to an
 * input token: output costs five times as much, writing the cache a quarter
 * more, reading it a tenth. Raw counts would let cache reads -- cheap, and by
 * far the largest number -- decide who gets paid.
 */
const WEIGHT = { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 }

const weighted = (u: Pick<UsageDay, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheCreationTokens'>) =>
  u.inputTokens * WEIGHT.input +
  u.outputTokens * WEIGHT.output +
  u.cacheCreationTokens * WEIGHT.cacheWrite +
  u.cacheReadTokens * WEIGHT.cacheRead

interface Person {
  login: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  turns: number
  units: number
}

/**
 * What each person's own Claude account has put into the project, over its
 * whole life, by login. Meant for settling up: pick a period, read the shares,
 * export the table.
 */
export function UsageView({ slug, snapshot }: { slug: string; snapshot: SessionSnapshot }) {
  const { data, error } = usePoll(() => api.history(slug), 60_000, slug)
  const [period, setPeriod] = useState<string>('all')

  const colour = useMemo(() => {
    const byLogin = new Map<string, string>()
    for (const p of [...snapshot.participants].sort((a, b) => a.joinedAt - b.joinedAt)) {
      const login = p.githubLogin.toLowerCase()
      if (!byLogin.has(login)) byLogin.set(login, BAR[p.colorIndex % BAR.length]!)
    }
    return (login: string) => byLogin.get(login) ?? 'bg-neutral-500'
  }, [snapshot.participants])

  const view = useMemo(() => {
    const all = data?.usage ?? []
    const months = [...new Set(all.map((u) => u.day.slice(0, 7)))].sort().reverse()
    const days = all.filter((u) => period === 'all' || u.day.startsWith(period))

    const people = new Map<string, Person>()
    for (const u of days) {
      const person = people.get(u.login) ?? {
        login: u.login,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        turns: 0,
        units: 0,
      }
      person.inputTokens += u.inputTokens
      person.outputTokens += u.outputTokens
      person.cacheReadTokens += u.cacheReadTokens
      person.cacheCreationTokens += u.cacheCreationTokens
      person.turns += u.turns
      person.units += weighted(u)
      people.set(u.login, person)
    }
    const ranked = [...people.values()].sort((a, b) => b.units - a.units)
    const total = ranked.reduce((sum, p) => sum + p.units, 0)

    // One bar per day in a month, one per month across all time.
    const key = (day: string) => (period === 'all' ? day.slice(0, 7) : day)
    const buckets = new Map<string, Map<string, number>>()
    for (const u of days) {
      const bucket = buckets.get(key(u.day)) ?? new Map<string, number>()
      bucket.set(u.login, (bucket.get(u.login) ?? 0) + weighted(u))
      buckets.set(key(u.day), bucket)
    }
    const bars = [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b))
    const peak = Math.max(1, ...bars.map(([, b]) => [...b.values()].reduce((s, n) => s + n, 0)))
    return { months, ranked, total, bars, peak }
  }, [data, period])

  if (!data) {
    return <p className="p-6 text-xs text-mute">{error ? `Could not read usage: ${error}` : 'reading usage…'}</p>
  }

  const exportCsv = () => {
    const header = 'login,input_tokens,output_tokens,cache_write_tokens,cache_read_tokens,turns,weighted_units,share_percent'
    const rows = view.ranked.map((p) =>
      [
        p.login,
        p.inputTokens,
        p.outputTokens,
        p.cacheCreationTokens,
        p.cacheReadTokens,
        p.turns,
        Math.round(p.units),
        view.total ? ((p.units / view.total) * 100).toFixed(2) : '0',
      ].join(','),
    )
    const blob = new Blob([[header, ...rows].join('\n') + '\n'], { type: 'text/csv' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = `${slug}-usage-${period}.csv`
    link.click()
    URL.revokeObjectURL(link.href)
  }

  return (
    <div className="h-full overflow-y-auto p-4 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="btn"
          value={period}
          onChange={(event) => setPeriod(event.target.value)}
          aria-label="period"
        >
          <option value="all">all time</option>
          {view.months.map((month) => (
            <option key={month} value={month}>
              {month}
            </option>
          ))}
        </select>
        <button className="btn" onClick={exportCsv} disabled={view.ranked.length === 0}>
          export CSV
        </button>
      </div>

      <div className="mt-4 flex flex-wrap gap-3">
        {view.ranked.map((p) => (
          <Stat
            key={p.login}
            label={`${p.login} · ${tokens(Math.round(p.units))} units`}
            value={view.total ? `${((p.units / view.total) * 100).toFixed(1)}%` : '—'}
          />
        ))}
        {view.ranked.length === 0 ? <p className="text-mute">Nothing recorded in this period.</p> : null}
      </div>

      {view.bars.length > 0 ? (
        <div className="panel mt-4 p-3">
          <p className="text-[10px] uppercase tracking-wider text-mute">
            Weighted usage by {period === 'all' ? 'month' : 'day'}
          </p>
          <div className="mt-3 flex h-36 items-end gap-1">
            {view.bars.map(([label, bucket]) => (
              <div
                key={label}
                className="flex h-full max-w-16 flex-1 flex-col-reverse"
                title={`${label}: ${[...bucket.entries()].map(([login, n]) => `${login} ${tokens(Math.round(n))}`).join(', ')}`}
              >
                {[...bucket.entries()].map(([login, n]) => (
                  <div key={login} className={colour(login)} style={{ height: `${(n / view.peak) * 100}%` }} />
                ))}
              </div>
            ))}
          </div>
          <div className="mt-1 flex justify-between text-[10px] text-mute">
            <span>{view.bars[0]![0]}</span>
            <span>{view.bars.at(-1)![0]}</span>
          </div>
        </div>
      ) : null}

      <table className="mt-4 w-full text-left">
        <thead className="text-[10px] uppercase tracking-wider text-mute">
          <tr>
            <th className="py-1 font-normal">person</th>
            <th className="py-1 text-right font-normal">input</th>
            <th className="py-1 text-right font-normal">output</th>
            <th className="py-1 text-right font-normal">cache write</th>
            <th className="py-1 text-right font-normal">cache read</th>
            <th className="py-1 text-right font-normal">turns</th>
            <th className="py-1 text-right font-normal">units</th>
            <th className="py-1 text-right font-normal">share</th>
          </tr>
        </thead>
        <tbody>
          {view.ranked.map((p) => (
            <tr key={p.login} className="border-t border-edge text-neutral-300">
              <td className="py-1">
                <span className={`mr-2 inline-block h-2 w-2 rounded-full ${colour(p.login)}`} />
                {p.login}
              </td>
              <td className="py-1 text-right">{tokens(p.inputTokens)}</td>
              <td className="py-1 text-right">{tokens(p.outputTokens)}</td>
              <td className="py-1 text-right">{tokens(p.cacheCreationTokens)}</td>
              <td className="py-1 text-right">{tokens(p.cacheReadTokens)}</td>
              <td className="py-1 text-right">{p.turns}</td>
              <td className="py-1 text-right">{tokens(Math.round(p.units))}</td>
              <td className="py-1 text-right">
                {view.total ? `${((p.units / view.total) * 100).toFixed(1)}%` : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="mt-4 max-w-2xl leading-relaxed text-mute">
        Units weight each token by what it would cost on the API, relative to an input token:
        output ×{WEIGHT.output}, cache write ×{WEIGHT.cacheWrite}, cache read ×{WEIGHT.cacheRead}.
        Each person&apos;s plugin reports what their own Claude Code spent in this project, including
        unattended autopilot runs. It is self-reported: a checkout with the plugin&apos;s hooks turned
        off reports nothing, so treat it as a fair guide, not an audit.
      </p>
    </div>
  )
}
