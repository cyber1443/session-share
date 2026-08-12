'use client'

import { useState } from 'react'
import type { Participant, SessionSnapshot, Task, Ticket, TicketState } from '@session-share/protocol'

const DOT = [
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
 * Five columns, one of them writable.
 *
 * Only `plan` is ever set by a person: you write a ticket there and everything
 * after that is a consequence of work actually happening -- splitting, building,
 * landing, shipping. Nothing is draggable, on purpose. A column you maintain by
 * hand drifts from the truth the moment anyone is busy, and then the board is
 * something to keep up to date rather than something to trust.
 */
const COLUMNS: Array<{ state: TicketState; label: string; hint: string }> = [
  { state: 'plan', label: 'plan', hint: 'write one' },
  { state: 'splitting', label: 'splitting', hint: 'an agent is reading the repo' },
  { state: 'building', label: 'building', hint: 'tasks in flight' },
  { state: 'review', label: 'review', hint: 'landed, PR pending' },
  { state: 'done', label: 'done', hint: '' },
]

export function Kanban({
  snapshot,
  meId,
  onCreate,
  onJoin,
  onLeave,
  onStart,
  onSelectTask,
}: {
  snapshot: SessionSnapshot
  meId: string | null
  onCreate: (title: string, body: string) => Promise<void>
  onJoin: (ticketId: string) => Promise<void>
  onLeave: (ticketId: string) => Promise<void>
  onStart: (ticketId: string) => Promise<void>
  onSelectTask: (taskId: string) => void
}) {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const create = async () => {
    const title = draft.trim()
    if (!title) return
    setBusy(true)
    setError(null)
    try {
      // A first line is a title; anything after it is the brief.
      const [first, ...rest] = title.split('\n')
      await onCreate(first!.trim(), rest.join('\n').trim())
      setDraft('')
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'failed')
    } finally {
      setBusy(false)
    }
  }

  const act = async (fn: () => Promise<void>) => {
    setError(null)
    try {
      await fn()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'failed')
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {error ? <p className="px-4 pt-2 text-xs text-red-400">{error}</p> : null}
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3">
        {COLUMNS.map((column) => {
          const tickets = snapshot.tickets.filter((ticket) => ticket.state === column.state)
          return (
            <section key={column.state} className="flex w-72 shrink-0 flex-col">
              <header className="flex items-baseline justify-between px-1 pb-2">
                <h2 className="text-[10px] uppercase tracking-wider text-mute">
                  {column.label} {tickets.length > 0 ? `· ${tickets.length}` : ''}
                </h2>
                <span className="text-[10px] text-mute/60">{column.hint}</span>
              </header>

              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
                {column.state === 'plan' ? (
                  <div className="panel p-2">
                    <textarea
                      className="field min-h-16 w-full resize-y text-xs leading-relaxed"
                      placeholder={'Add due dates to todos\nOptional: a line or two on what you mean.'}
                      value={draft}
                      disabled={busy}
                      onChange={(event) => setDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                          event.preventDefault()
                          void create()
                        }
                      }}
                    />
                    <div className="mt-2 flex items-center justify-between">
                      <span className="text-[10px] text-mute">⌘↵ to open it</span>
                      <button className="btn" disabled={!draft.trim() || busy} onClick={() => void create()}>
                        open
                      </button>
                    </div>
                  </div>
                ) : null}

                {tickets.map((ticket) => (
                  <Card
                    key={ticket.id}
                    ticket={ticket}
                    tasks={snapshot.tasks.filter((task) => task.ticketId === ticket.id)}
                    participants={snapshot.participants}
                    meId={meId}
                    onJoin={() => void act(() => onJoin(ticket.id))}
                    onLeave={() => void act(() => onLeave(ticket.id))}
                    onStart={() => void act(() => onStart(ticket.id))}
                    onSelectTask={onSelectTask}
                  />
                ))}

                {tickets.length === 0 && column.state !== 'plan' ? (
                  <p className="px-1 text-[10px] text-mute/50">nothing here</p>
                ) : null}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}

function Card({
  ticket,
  tasks,
  participants,
  meId,
  onJoin,
  onLeave,
  onStart,
  onSelectTask,
}: {
  ticket: Ticket
  tasks: Task[]
  participants: Participant[]
  meId: string | null
  onJoin: () => void
  onLeave: () => void
  onStart: () => void
  onSelectTask: (taskId: string) => void
}) {
  const mine = Boolean(meId && ticket.members.includes(meId as never))
  const members = ticket.members
    .map((id) => participants.find((p) => p.id === id))
    .filter((p): p is Participant => Boolean(p))
  const merged = tasks.filter((task) => task.state === 'merged').length

  return (
    <article className="panel space-y-2 p-3">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-xs leading-snug text-neutral-200">{ticket.title}</h3>
        {ticket.prNumber ? (
          <span className="shrink-0 text-[10px] text-accent">#{ticket.prNumber}</span>
        ) : null}
      </div>

      {ticket.body ? (
        <p className="line-clamp-3 text-[10px] leading-relaxed text-mute">{ticket.body}</p>
      ) : null}

      {tasks.length > 0 ? (
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-[10px] text-mute">
            <span>
              {merged}/{tasks.length} landed
            </span>
            <span className="h-1 flex-1 overflow-hidden rounded bg-neutral-800">
              <span
                className="block h-full bg-accent transition-all"
                style={{ width: `${(merged / tasks.length) * 100}%` }}
              />
            </span>
          </div>
          <ul className="space-y-0.5">
            {tasks.map((task) => {
              const owner = participants.find((p) => p.id === (task.ownerId ?? task.assigneeId))
              return (
                <li key={task.id}>
                  <button
                    className="flex w-full items-center gap-1.5 text-left text-[10px] text-mute hover:text-neutral-300"
                    onClick={() => onSelectTask(task.id)}
                  >
                    <span
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                        owner ? DOT[owner.colorIndex % DOT.length] : 'bg-neutral-700'
                      } ${task.state === 'merged' ? '' : 'opacity-60'}`}
                    />
                    <span className="truncate">{task.id}</span>
                    <span className="ml-auto shrink-0 text-mute/60">{task.state}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        <div className="flex -space-x-1">
          {members.map((member) => (
            <span
              key={member.id}
              title={member.displayName}
              className={`h-2.5 w-2.5 rounded-full ring-1 ring-panel ${DOT[member.colorIndex % DOT.length]}`}
            />
          ))}
        </div>
        <span className="text-[10px] text-mute">
          {members.map((m) => m.displayName).join(', ') || 'nobody yet'}
        </span>

        <div className="ml-auto flex gap-2">
          {ticket.state === 'plan' && mine ? (
            <button className="btn text-[10px]" onClick={onStart} title="Split it now instead of waiting">
              start
            </button>
          ) : null}
          {mine ? (
            ticket.state === 'plan' ? (
              <button className="btn text-[10px]" onClick={onLeave}>
                leave
              </button>
            ) : null
          ) : (
            <button className="btn btn-accent text-[10px]" onClick={onJoin} disabled={!meId}>
              join
            </button>
          )}
        </div>
      </div>
    </article>
  )
}
