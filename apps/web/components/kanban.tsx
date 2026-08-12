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
const COLUMNS: Array<{ states: TicketState[]; label: string; hint: string }> = [
  { states: ['plan'], label: 'plan', hint: 'write one' },
  { states: ['splitting', 'proposed'], label: 'splitting', hint: 'being planned' },
  { states: ['building'], label: 'building', hint: 'tasks in flight' },
  { states: ['verify'], label: 'verify', hint: 'run it for real' },
  /**
   * Review is the end. Merging is a person's call, so a ticket sits here with
   * its PR open until someone decides -- there is nothing after that this can
   * honestly claim to know about.
   */
  { states: ['review', 'done'], label: 'review', hint: 'PR open — yours to merge' },
]

export function Kanban({
  snapshot,
  meId,
  onCreate,
  onJoin,
  onOpen,
  selected,
}: {
  snapshot: SessionSnapshot
  meId: string | null
  onCreate: (title: string, body: string) => Promise<void>
  onJoin: (ticketId: string) => Promise<void>
  onOpen: (ticketId: string) => void
  selected: string | null
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
          const tickets = snapshot.tickets.filter((ticket) => column.states.includes(ticket.state))
          return (
            <section key={column.label} className="flex w-72 shrink-0 flex-col">
              <header className="flex items-baseline justify-between px-1 pb-2">
                <h2 className="text-[10px] uppercase tracking-wider text-mute">
                  {column.label} {tickets.length > 0 ? `· ${tickets.length}` : ''}
                </h2>
                <span className="text-[10px] text-mute/60">{column.hint}</span>
              </header>

              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
                {column.states[0] === 'plan' ? (
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
                    selected={selected === ticket.id}
                    onOpen={() => onOpen(ticket.id)}
                    onJoin={() => void act(() => onJoin(ticket.id))}
                  />
                ))}

                {tickets.length === 0 && column.states[0] !== 'plan' ? (
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
  selected,
  onOpen,
  onJoin,
}: {
  ticket: Ticket
  tasks: Task[]
  participants: Participant[]
  meId: string | null
  selected: boolean
  onOpen: () => void
  onJoin: () => void
}) {
  const mine = Boolean(meId && ticket.members.includes(meId as never))
  const members = ticket.members
    .map((id) => participants.find((p) => p.id === id))
    .filter((p): p is Participant => Boolean(p))
  const merged = tasks.filter((task) => task.state === 'merged').length

  return (
    <article
      className={`panel w-full cursor-pointer space-y-2 p-3 text-left transition-colors hover:bg-[#12151b] ${
        selected ? 'ring-1 ring-neutral-500' : ''
      }`}
      onClick={onOpen}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-xs leading-snug text-neutral-200">{ticket.title}</h3>
        {ticket.prNumber ? (
          <span className="shrink-0 text-[10px] text-accent" title="open until you merge it">
            PR #{ticket.prNumber}
          </span>
        ) : null}
      </div>

      {/* A split that has been proposed is waiting on a person, so say so loudly. */}
      {ticket.state === 'proposed' ? (
        <p className="text-[10px] font-medium text-accent">split ready — open to start it</p>
      ) : null}
      {ticket.state === 'review' && !ticket.prNumber ? (
        <p className="text-[10px] text-mute">verified — opening the pull request</p>
      ) : null}
      {ticket.state === 'verify' ? (
        <p
          className={`text-[10px] ${ticket.verification ? 'text-red-400' : 'text-amber-400/80'}`}
        >
          {ticket.verification
            ? 'ran it — broken, being fixed'
            : 'everything landed; someone is running it end to end'}
        </p>
      ) : null}
      {ticket.state === 'splitting' ? (
        <p className="text-[10px] text-amber-400/80">
          {members.find((m) => m.repoPath)?.id === meId
            ? 'waiting on your Claude Code'
            : `handed to ${members.find((m) => m.repoPath)?.displayName ?? 'an agent'}`}
        </p>
      ) : null}

      {tasks.length > 0 ? (
        <div className="flex items-center gap-2 text-[10px] text-mute">
          <span>
            {merged}/{tasks.length}
          </span>
          <span className="h-1 flex-1 overflow-hidden rounded bg-neutral-800">
            <span
              className="block h-full bg-accent transition-all"
              style={{ width: `${(merged / tasks.length) * 100}%` }}
            />
          </span>
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
        <span className="truncate text-[10px] text-mute">
          {members.map((m) => m.displayName).join(', ') || 'nobody yet'}
        </span>
        {!mine ? (
          <button
            className="btn btn-accent ml-auto text-[10px]"
            disabled={!meId}
            onClick={(event) => {
              event.stopPropagation()
              onJoin()
            }}
          >
            join
          </button>
        ) : null}
      </div>
    </article>
  )
}
