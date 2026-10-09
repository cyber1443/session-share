'use client'

import { useMemo, useState } from 'react'
import type { SessionSnapshot } from '@session-share/protocol'
import { api, type HistoryEntry } from '@/lib/api'
import { usePoll } from '@/lib/poll'

const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const WEEKS_SHOWN = 26

/** Monday 00:00 local time of the week `ts` falls in. */
export function weekStart(ts: number): number {
  const date = new Date(ts)
  date.setHours(0, 0, 0, 0)
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7))
  return date.getTime()
}

/**
 * The project's long view: what was opened, split, built, landed and shipped,
 * and how fast. Read from the whole log, not the room, so nothing here scrolls
 * away after the last 500 messages.
 */
export function HistoryView({ slug, snapshot }: { slug: string; snapshot: SessionSnapshot }) {
  const { data, error } = usePoll(() => api.history(slug), 30_000, slug)
  const [shown, setShown] = useState(200)

  const names = useMemo(() => {
    const byId = new Map<string, string>()
    for (const p of snapshot.participants) byId.set(p.id, p.displayName)
    return byId
  }, [snapshot.participants])

  const view = useMemo(() => {
    const entries = data?.entries ?? []
    const tickets = new Map<string, string>()
    const tasks = new Map<string, string>()
    for (const entry of entries) {
      if (entry.type === 'ticket.created' && entry.ticketId && entry.title) tickets.set(entry.ticketId, entry.title)
      for (const task of entry.tasks ?? []) tasks.set(task.id, task.title)
    }

    const now = weekStart(Date.now())
    const weeks = Array.from({ length: WEEKS_SHOWN }, (_, i) => ({
      start: now - (WEEKS_SHOWN - 1 - i) * WEEK_MS,
      opened: 0,
      landed: 0,
      shipped: 0,
    }))
    const bucket = (ts: number) => weeks.find((week) => week.start === weekStart(ts))
    let opened = 0
    let landed = 0
    let shipped = 0
    for (const entry of entries) {
      if (entry.type === 'ticket.created') {
        opened++
        const week = bucket(entry.ts)
        if (week) week.opened++
      }
      if (entry.type === 'task.state' && entry.state === 'merged') {
        landed++
        const week = bucket(entry.ts)
        if (week) week.landed++
      }
      if (entry.type === 'ticket.shipped') {
        shipped++
        const week = bucket(entry.ts)
        if (week) week.shipped++
      }
    }
    // Board seats joining are noise in a project's story; checkouts arriving are not.
    const lines = entries
      .filter((entry) => !(entry.type === 'participant.joined' && !entry.ok))
      .filter((entry) => !(entry.type === 'ticket.state'))
      .slice()
      .reverse()
    return { tickets, tasks, weeks, opened, landed, shipped, lines }
  }, [data])

  if (!data) {
    return <p className="p-6 text-xs text-mute">{error ? `Could not read the history: ${error}` : 'reading the history…'}</p>
  }

  const peak = Math.max(1, ...view.weeks.map((week) => Math.max(week.opened, week.landed)))
  const say = (entry: HistoryEntry) => describe(entry, names, view.tickets, view.tasks)

  let lastDay = ''
  return (
    <div className="h-full overflow-y-auto p-4 text-xs">
      <div className="flex flex-wrap gap-3">
        <Stat label="tickets opened" value={view.opened} />
        <Stat label="tasks landed" value={view.landed} />
        <Stat label="tickets shipped" value={view.shipped} />
        <Stat
          label="since"
          value={data.entries[0] ? new Date(data.entries[0].ts).toLocaleDateString() : '—'}
        />
      </div>

      <div className="panel mt-4 p-3">
        <div className="flex items-baseline justify-between">
          <p className="text-[10px] uppercase tracking-wider text-mute">Last {WEEKS_SHOWN} weeks</p>
          <p className="text-[10px] text-mute">
            <span className="mr-1 inline-block h-2 w-2 bg-sky-400/70" />
            opened
            <span className="ml-3 mr-1 inline-block h-2 w-2 bg-emerald-400" />
            landed
          </p>
        </div>
        <div className="mt-3 flex h-28 items-end gap-1">
          {view.weeks.map((week) => (
            <div
              key={week.start}
              className="flex h-full max-w-16 flex-1 items-end gap-px"
              title={`week of ${new Date(week.start).toLocaleDateString()}: ${week.opened} opened, ${week.landed} landed, ${week.shipped} shipped`}
            >
              <div className="flex-1 bg-sky-400/70" style={{ height: `${(week.opened / peak) * 100}%` }} />
              <div className="flex-1 bg-emerald-400" style={{ height: `${(week.landed / peak) * 100}%` }} />
            </div>
          ))}
        </div>
        <div className="mt-1 flex justify-between text-[10px] text-mute">
          <span>{new Date(view.weeks[0]!.start).toLocaleDateString()}</span>
          <span>this week</span>
        </div>
      </div>

      <div className="mt-4 space-y-1">
        {view.lines.slice(0, shown).map((entry) => {
          const day = new Date(entry.ts).toLocaleDateString(undefined, {
            weekday: 'short',
            year: 'numeric',
            month: 'short',
            day: 'numeric',
          })
          const header = day !== lastDay ? day : null
          lastDay = day
          return (
            <div key={entry.seq}>
              {header ? (
                <p className="pb-1 pt-3 text-[10px] uppercase tracking-wider text-mute">{header}</p>
              ) : null}
              <p className="flex gap-3 leading-relaxed">
                <span className="w-20 shrink-0 whitespace-nowrap text-mute">
                  {new Date(entry.ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                </span>
                <span className={tone(entry)}>{say(entry)}</span>
              </p>
            </div>
          )
        })}
        {view.lines.length > shown ? (
          <button className="btn mt-2" onClick={() => setShown((n) => n + 400)}>
            show older ({view.lines.length - shown} more)
          </button>
        ) : null}
      </div>
    </div>
  )
}

export function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="panel min-w-28 px-3 py-2">
      <p className="text-base text-neutral-200">{value}</p>
      <p className="text-[10px] uppercase tracking-wider text-mute">{label}</p>
    </div>
  )
}

function tone(entry: HistoryEntry): string {
  if (entry.type === 'merge.conflict' || entry.ok === false) return 'text-red-400'
  if (entry.type === 'ticket.shipped' || (entry.type === 'task.state' && entry.state === 'merged')) {
    return 'text-emerald-400'
  }
  return 'text-neutral-300'
}

function describe(
  entry: HistoryEntry,
  names: Map<string, string>,
  tickets: Map<string, string>,
  tasks: Map<string, string>,
): string {
  const who = (entry.actorId && names.get(entry.actorId)) || 'Someone'
  const ticket = `"${(entry.ticketId && tickets.get(entry.ticketId)) || 'a ticket'}"`
  const task = (entry.taskId && tasks.get(entry.taskId)) || entry.taskId || 'a task'
  switch (entry.type) {
    case 'session.created':
      return `Project started: ${entry.title}`
    case 'participant.joined':
      return `${entry.login} attached a checkout`
    case 'ticket.created':
      return `${who} opened "${entry.title}"`
    case 'ticket.verified':
      return `${ticket} ${entry.ok ? 'passed' : 'failed'} its run${entry.summary ? `: ${entry.summary}` : ''}`
    case 'ticket.shipped':
      return `${ticket} shipped${entry.prNumber ? ` as PR #${entry.prNumber}` : ''}`
    case 'ticket.deleted':
      return `${who} deleted ${ticket}`
    case 'decomposition.proposed':
      return `${who} proposed a ${entry.tasks?.length ?? 0}-task split for ${ticket}${entry.ok ? '' : ' (the validator refused it)'}`
    case 'contract.committed':
      return `The shared contract for ${ticket} landed on ${entry.branch}`
    case 'tasks.seeded':
      return `Work started on ${ticket}: ${entry.tasks?.length ?? 0} task(s)`
    case 'task.state':
      return entry.state === 'merged' ? `${task} landed` : `${who} picked up ${task}`
    case 'task.test':
      return `${task}: tests ${entry.ok ? 'passed' : 'failed'}`
    case 'merge.conflict':
      return `${task} hit a merge conflict in ${(entry.paths ?? []).join(', ')}`
    case 'integration.pr':
      return `Pull request #${entry.prNumber} opened`
    default:
      return entry.type
  }
}
