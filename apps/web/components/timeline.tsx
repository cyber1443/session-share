'use client'

import { useMemo, useState } from 'react'
import type { SessionSnapshot, Sprint, Ticket, TicketState } from '@session-share/protocol'
import type { Send } from '@/lib/live'
import { DAY_MS, fromDateInput, shortDate, startOfDay, toDateInput } from '@/lib/dates'

/** Width of one day on the chart. */
const DAY_PX = 28
/** The label column on the left. */
const LABEL_PX = 240

const BAR: Record<TicketState, string> = {
  plan: 'border border-dashed border-neutral-600 bg-transparent',
  splitting: 'bg-amber-500/50',
  proposed: 'bg-amber-400/70',
  building: 'bg-sky-500/70',
  verify: 'bg-violet-500/70',
  review: 'bg-teal-500/70',
  done: 'bg-emerald-500/70',
}

const SPRINT_TONE: Record<Sprint['state'], string> = {
  planned: 'text-mute',
  active: 'text-accent',
  closed: 'text-neutral-500',
}

/**
 * The project laid out in time: sprints as bands, tickets as bars from when
 * work on them started to when they merged (or today), and the date each one
 * is wanted by. Sprints are created and moved along here too, since this is
 * the only place their dates mean anything.
 */
export function TimelineView({
  snapshot,
  send,
  onOpenTicket,
}: {
  snapshot: SessionSnapshot
  send: Send
  onOpenTicket: (ticketId: string) => void
}) {
  const [error, setError] = useState<string | null>(null)
  const sprints = useMemo(
    () => [...(snapshot.sprints ?? [])].sort((a, b) => a.startsAt - b.startsAt),
    [snapshot.sprints],
  )
  const tickets = snapshot.tickets

  const act = async (fn: () => Promise<unknown>) => {
    setError(null)
    try {
      await fn()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'failed')
    }
  }

  const today = startOfDay(Date.now())
  const { from, days } = useMemo(() => {
    const points = [today]
    for (const sprint of sprints) points.push(sprint.startsAt, sprint.endsAt)
    for (const ticket of tickets) {
      points.push(ticket.startedAt ?? ticket.createdAt)
      if (ticket.dueAt) points.push(ticket.dueAt)
      if (ticket.mergedAt) points.push(ticket.mergedAt)
    }
    const first = startOfDay(Math.min(...points)) - 2 * DAY_MS
    const last = startOfDay(Math.max(...points)) + 7 * DAY_MS
    return { from: first, days: Math.max(14, Math.round((last - first) / DAY_MS)) }
  }, [sprints, tickets, today])

  /**
   * Calendar days, counted on the calendar rather than in 24-hour steps: a
   * day with a clock change in it is 23 or 25 hours long, and stepping by
   * milliseconds then shows one date twice or skips one.
   */
  const calendar = useMemo(() => {
    const first = new Date(from)
    return Array.from({ length: days }, (_, i) => new Date(first.getFullYear(), first.getMonth(), first.getDate() + i))
  }, [from, days])
  const x = (ts: number) => ((ts - from) / DAY_MS) * DAY_PX
  const groups: Array<{ sprint: Sprint | null; tickets: Ticket[] }> = [
    ...sprints.map((sprint) => ({ sprint, tickets: tickets.filter((t) => t.sprintId === sprint.id) })),
    { sprint: null, tickets: tickets.filter((t) => !t.sprintId || !sprints.some((s) => s.id === t.sprintId)) },
  ]

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <Sprints sprints={sprints} tickets={tickets} send={send} act={act} />
      {error ? <p className="px-4 pb-2 text-xs text-red-400">{error}</p> : null}

      <div className="min-h-0 flex-1 overflow-x-auto border-t border-edge">
        <div style={{ width: LABEL_PX + days * DAY_PX }} className="relative text-[10px]">
          {/* the day ruler: months above, days below */}
          <div className="sticky top-0 z-20 border-b border-edge bg-ink">
            <div className="flex">
              <div style={{ width: LABEL_PX }} className="sticky left-0 z-30 shrink-0 bg-ink" />
              {calendar.map((day, i) => (
                <div key={i} style={{ width: DAY_PX }} className="shrink-0 overflow-visible whitespace-nowrap pt-1 text-neutral-400">
                  {i === 0 || day.getDate() === 1 ? day.toLocaleDateString([], { month: 'short', year: i === 0 ? 'numeric' : undefined }) : ''}
                </div>
              ))}
            </div>
            <div className="flex">
              <div style={{ width: LABEL_PX }} className="sticky left-0 z-30 shrink-0 bg-ink px-3 pb-1 text-mute">
                ticket
              </div>
              {calendar.map((day, i) => {
                const isToday = day.getTime() === today
                const weekend = day.getDay() === 0 || day.getDay() === 6
                return (
                  <div
                    key={i}
                    style={{ width: DAY_PX }}
                    className={`shrink-0 pb-1 text-center ${isToday ? 'text-accent' : weekend ? 'text-mute/40' : 'text-mute'}`}
                    title={day.toDateString()}
                  >
                    {day.getDate()}
                  </div>
                )
              })}
            </div>
          </div>

          {/* today */}
          <div
            className="pointer-events-none absolute bottom-0 top-0 z-10 w-px bg-accent/40"
            style={{ left: LABEL_PX + x(Date.now()) }}
          />

          {groups.map(({ sprint, tickets: rows }) =>
            sprint || rows.length > 0 ? (
              <div key={sprint?.id ?? 'backlog'} className="border-b border-edge/60">
                <div className="relative flex h-7 items-center">
                  <div
                    style={{ width: LABEL_PX }}
                    className="sticky left-0 z-10 flex h-full shrink-0 items-center gap-2 bg-ink px-3"
                  >
                    <span className={`truncate uppercase tracking-wider ${sprint ? SPRINT_TONE[sprint.state] : 'text-mute'}`}>
                      {sprint?.name ?? 'backlog'}
                    </span>
                    <span className="text-mute/60">{rows.length}</span>
                  </div>
                  {sprint ? (
                    <div
                      className={`absolute top-1 h-5 rounded-sm ${sprint.state === 'active' ? 'bg-accent/10 ring-1 ring-accent/30' : 'bg-neutral-800/40'}`}
                      style={{ left: LABEL_PX + x(sprint.startsAt), width: Math.max(DAY_PX, x(sprint.endsAt) - x(sprint.startsAt)) }}
                      title={`${sprint.name}: ${shortDate(sprint.startsAt)} – ${shortDate(sprint.endsAt)}`}
                    />
                  ) : null}
                </div>
                {rows.map((ticket) => (
                  <Row key={ticket.id} ticket={ticket} x={x} onOpen={() => onOpenTicket(ticket.id)} />
                ))}
              </div>
            ) : null,
          )}
          {tickets.length === 0 ? <p className="px-3 py-6 text-mute">No tickets yet.</p> : null}
        </div>
      </div>
    </div>
  )
}

function Row({ ticket, x, onOpen }: { ticket: Ticket; x: (ts: number) => number; onOpen: () => void }) {
  const started = ticket.startedAt
  const start = started ?? ticket.createdAt
  // Not started yet: drawn as a dashed promise from when it was written to when it is wanted.
  const end = ticket.mergedAt ?? (started ? Date.now() : (ticket.dueAt ?? ticket.createdAt + DAY_MS))
  const left = x(start)
  const width = Math.max(DAY_PX / 2, x(end) - left)
  const subtickets = ticket.subtickets ?? []
  const done = subtickets.filter((s) => s.state === 'done').length
  const overdue = ticket.dueAt !== null && !ticket.mergedAt && ticket.dueAt < Date.now()

  return (
    <div className="group relative flex h-7 cursor-pointer items-center hover:bg-neutral-900/60" onClick={onOpen}>
      <div
        style={{ width: LABEL_PX }}
        className="sticky left-0 z-10 flex h-full shrink-0 items-center gap-2 bg-ink px-3 group-hover:bg-neutral-900"
      >
        <span className="truncate text-neutral-300" title={ticket.title}>
          {ticket.title}
        </span>
        {subtickets.length > 0 ? (
          <span className="ml-auto shrink-0 text-mute">
            {done}/{subtickets.length}
          </span>
        ) : null}
      </div>
      <div
        className={`absolute h-3.5 rounded-sm ${BAR[ticket.state]}`}
        style={{ left: LABEL_PX + left, width }}
        title={`${ticket.title} · ${ticket.state}${started ? ` · started ${shortDate(started)}` : ''}${ticket.mergedAt ? ` · merged ${shortDate(ticket.mergedAt)}` : ''}`}
      />
      {ticket.dueAt ? (
        <div
          className={`absolute h-2.5 w-2.5 rotate-45 ${overdue ? 'bg-red-400' : ticket.mergedAt ? 'bg-emerald-400/60' : 'bg-amber-300'}`}
          style={{ left: LABEL_PX + x(ticket.dueAt) - 5 }}
          title={`due ${shortDate(ticket.dueAt)}${overdue ? ' (overdue)' : ''}`}
        />
      ) : null}
    </div>
  )
}

function Sprints({
  sprints,
  tickets,
  send,
  act,
}: {
  sprints: Sprint[]
  tickets: Ticket[]
  send: Send
  act: (fn: () => Promise<unknown>) => Promise<void>
}) {
  const [creating, setCreating] = useState(false)
  const nextStart = Math.max(startOfDay(Date.now()), ...sprints.map((s) => s.endsAt))
  const [name, setName] = useState('')
  const [start, setStart] = useState(toDateInput(nextStart))
  const [end, setEnd] = useState(toDateInput(nextStart + 14 * DAY_MS))
  const [goal, setGoal] = useState('')

  const openForm = () => {
    setName(`Sprint ${sprints.length + 1}`)
    setStart(toDateInput(nextStart))
    setEnd(toDateInput(nextStart + 14 * DAY_MS))
    setGoal('')
    setCreating(true)
  }

  const create = () =>
    act(async () => {
      const startsAt = fromDateInput(start)
      const endsAt = fromDateInput(end)
      if (startsAt === null || endsAt === null) throw new Error('Pick both dates.')
      // The end date is inclusive on the form: a sprint to Friday runs through Friday.
      await send({ type: 'sprint.create', name: name.trim(), goal, startsAt, endsAt: endsAt + DAY_MS - 1 })
      setCreating(false)
    })

  return (
    <div className="space-y-2 p-3">
      <div className="flex items-center justify-between">
        <p className="text-[10px] uppercase tracking-wider text-mute">Sprints</p>
        {!creating ? (
          <button className="btn" onClick={openForm}>
            new sprint
          </button>
        ) : null}
      </div>

      {creating ? (
        <div className="panel grid grid-cols-[1fr_auto_auto] items-end gap-2 p-2 text-[11px]">
          <label className="space-y-1">
            <span className="text-[10px] text-mute">name</span>
            <input className="field py-1 text-xs" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="space-y-1">
            <span className="text-[10px] text-mute">from</span>
            <input type="date" className="field py-1 text-xs" value={start} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label className="space-y-1">
            <span className="text-[10px] text-mute">to</span>
            <input type="date" className="field py-1 text-xs" value={end} onChange={(e) => setEnd(e.target.value)} />
          </label>
          <input
            className="field col-span-3 py-1 text-xs"
            placeholder="Goal (optional)"
            value={goal}
            maxLength={2000}
            onChange={(e) => setGoal(e.target.value)}
          />
          <div className="col-span-3 flex justify-end gap-2">
            <button className="btn" onClick={() => setCreating(false)}>
              cancel
            </button>
            <button className="btn btn-accent" disabled={!name.trim()} onClick={() => void create()}>
              create
            </button>
          </div>
        </div>
      ) : null}

      {sprints.length === 0 && !creating ? (
        <p className="text-[11px] text-mute">
          No sprints. Everything is in the backlog; make one to plan tickets into a stretch of time.
        </p>
      ) : null}

      <ul className="space-y-1">
        {sprints.map((sprint) => {
          const mine = tickets.filter((t) => t.sprintId === sprint.id)
          const done = mine.filter((t) => t.mergedAt).length
          return (
            <li key={sprint.id} className="panel flex flex-wrap items-center gap-3 px-2 py-1.5 text-[11px]">
              <span className={`uppercase tracking-wider ${SPRINT_TONE[sprint.state]}`}>{sprint.state}</span>
              <span className="text-neutral-200">{sprint.name}</span>
              <span className="text-mute">
                {shortDate(sprint.startsAt)} – {shortDate(sprint.endsAt)}
              </span>
              <span className="text-mute">
                {done}/{mine.length} done
              </span>
              {sprint.goal ? <span className="min-w-0 flex-1 truncate text-mute" title={sprint.goal}>{sprint.goal}</span> : <span className="flex-1" />}
              <span className="flex gap-2">
                {sprint.state === 'planned' ? (
                  <button className="btn btn-accent py-0.5" onClick={() => void act(() => send({ type: 'sprint.update', sprintId: sprint.id, state: 'active' }))}>
                    start
                  </button>
                ) : null}
                {sprint.state === 'active' ? (
                  <button className="btn py-0.5" onClick={() => void act(() => send({ type: 'sprint.update', sprintId: sprint.id, state: 'closed' }))}>
                    close
                  </button>
                ) : null}
                {sprint.state === 'closed' ? (
                  <button className="btn py-0.5" onClick={() => void act(() => send({ type: 'sprint.update', sprintId: sprint.id, state: 'planned' }))}>
                    reopen
                  </button>
                ) : null}
                <button
                  className="btn py-0.5 text-mute hover:text-red-400"
                  title="Its tickets go back to the backlog"
                  onClick={() => {
                    if (window.confirm(`Delete "${sprint.name}"? Its ${mine.length} ticket(s) go back to the backlog.`)) {
                      void act(() => send({ type: 'sprint.delete', sprintId: sprint.id }))
                    }
                  }}
                >
                  delete
                </button>
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
