'use client'

import { useState } from 'react'
import { TICKET_BODY_MAX, type SessionSnapshot, type Ticket } from '@session-share/protocol'
import type { Send } from '@/lib/live'
import { fromDateInput, toDateInput } from '@/lib/dates'

/**
 * A ticket's title and description, editable in place. Anyone in the room
 * can reword a card -- the same people can delete it -- and once it has been
 * split the people building it are told the brief moved.
 */
export function Description({ ticket, send }: { ticket: Ticket; send: Send }) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(ticket.title)
  const [body, setBody] = useState(ticket.body)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const open = () => {
    setTitle(ticket.title)
    setBody(ticket.body)
    setError(null)
    setEditing(true)
  }

  const save = async () => {
    if (!title.trim()) return
    setBusy(true)
    setError(null)
    try {
      await send({ type: 'ticket.edit', ticketId: ticket.id, title: title.trim(), body })
      setEditing(false)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'failed')
    } finally {
      setBusy(false)
    }
  }

  if (editing) {
    return (
      <div className="space-y-2">
        <input
          className="field text-xs"
          value={title}
          maxLength={200}
          disabled={busy}
          onChange={(event) => setTitle(event.target.value)}
        />
        <textarea
          className="field min-h-40 resize-y text-xs leading-relaxed"
          placeholder="What it is, why it matters, what done looks like."
          value={body}
          maxLength={TICKET_BODY_MAX}
          disabled={busy}
          autoFocus
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              void save()
            }
            if (event.key === 'Escape') setEditing(false)
          }}
        />
        {error ? <p className="text-[11px] text-red-400">{error}</p> : null}
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-mute">
            {body.length.toLocaleString()} / {TICKET_BODY_MAX.toLocaleString()} · ⌘↵ saves
          </span>
          <button className="btn ml-auto" disabled={busy} onClick={() => setEditing(false)}>
            cancel
          </button>
          <button className="btn btn-accent" disabled={busy || !title.trim()} onClick={() => void save()}>
            save
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="group space-y-1">
      <div className="flex items-baseline justify-between">
        <p className="text-[10px] uppercase tracking-wider text-mute">Description</p>
        <button className="text-[10px] text-mute hover:text-neutral-300" onClick={open}>
          edit
        </button>
      </div>
      {ticket.body ? (
        <p className="whitespace-pre-wrap break-words leading-relaxed text-neutral-400">{ticket.body}</p>
      ) : (
        <button className="text-[11px] text-mute/70 hover:text-neutral-300" onClick={open}>
          add a description
        </button>
      )}
    </div>
  )
}

/** Which sprint a ticket is planned into, and when it is wanted by. */
export function PlanFields({ ticket, snapshot, send }: { ticket: Ticket; snapshot: SessionSnapshot; send: Send }) {
  const [error, setError] = useState<string | null>(null)
  const sprints = (snapshot.sprints ?? []).filter((s) => s.state !== 'closed' || s.id === ticket.sprintId)
  const overdue = ticket.dueAt !== null && !ticket.mergedAt && ticket.dueAt < Date.now()

  const act = async (fn: () => Promise<unknown>) => {
    setError(null)
    try {
      await fn()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'failed')
    }
  }

  return (
    <div className="space-y-1">
      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1">
          <span className="text-[10px] uppercase tracking-wider text-mute">Sprint</span>
          <select
            className="field py-1 text-[11px]"
            value={ticket.sprintId ?? ''}
            onChange={(event) =>
              void act(() => send({ type: 'ticket.setSprint', ticketId: ticket.id, sprintId: event.target.value || null }))
            }
          >
            <option value="">backlog</option>
            {sprints.map((sprint) => (
              <option key={sprint.id} value={sprint.id}>
                {sprint.name}
                {sprint.state === 'active' ? ' (active)' : sprint.state === 'closed' ? ' (closed)' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className={`text-[10px] uppercase tracking-wider ${overdue ? 'text-red-400' : 'text-mute'}`}>
            Due{overdue ? ' · overdue' : ''}
          </span>
          <input
            type="date"
            className="field py-1 text-[11px]"
            value={toDateInput(ticket.dueAt)}
            onChange={(event) =>
              void act(() => send({ type: 'ticket.setDue', ticketId: ticket.id, dueAt: fromDateInput(event.target.value) }))
            }
          />
        </label>
      </div>
      {error ? <p className="text-[11px] text-red-400">{error}</p> : null}
    </div>
  )
}
