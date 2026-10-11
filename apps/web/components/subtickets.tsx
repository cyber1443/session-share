'use client'

import { useState } from 'react'
import type { Participant, SessionSnapshot, Subticket, SubticketState, Ticket } from '@session-share/protocol'
import type { Send } from '@/lib/live'
import { DOT } from '@/lib/palette'

const NEXT: Record<SubticketState, SubticketState> = { todo: 'doing', doing: 'done', done: 'todo' }
const MARK: Record<SubticketState, string> = { todo: '[ ]', doing: '[~]', done: '[x]' }
const TONE: Record<SubticketState, string> = {
  todo: 'text-neutral-300',
  doing: 'text-sky-400',
  done: 'text-mute line-through',
}

/**
 * The pieces of a ticket and who is looking after each. Joining one says
 * "this part is mine"; it does not put anyone into the ticket's split.
 */
export function Subtickets({
  ticket,
  snapshot,
  meId,
  send,
}: {
  ticket: Ticket
  snapshot: SessionSnapshot
  meId: string | null
  send: Send
}) {
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const subtickets = ticket.subtickets ?? []
  const done = subtickets.filter((s) => s.state === 'done').length

  const act = async (fn: () => Promise<unknown>) => {
    setError(null)
    try {
      await fn()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'failed')
    }
  }

  const add = async () => {
    const title = draft.trim()
    if (!title) return
    await act(async () => {
      await send({ type: 'subticket.add', ticketId: ticket.id, title })
      setDraft('')
    })
  }

  return (
    <div className="space-y-3">
      {subtickets.length > 0 ? (
        <div className="flex items-center gap-2 text-[10px] text-mute">
          <span>
            {done}/{subtickets.length} done
          </span>
          <span className="h-1 flex-1 overflow-hidden rounded bg-neutral-800">
            <span className="block h-full bg-accent transition-all" style={{ width: `${(done / subtickets.length) * 100}%` }} />
          </span>
        </div>
      ) : (
        <p className="leading-relaxed text-mute">
          Break the ticket into pieces people can tick off. Each piece has its own people; joining one does not put
          you into the ticket&apos;s split.
        </p>
      )}

      <ul className="space-y-1.5">
        {subtickets.map((subticket) => (
          <Row
            key={subticket.id}
            subticket={subticket}
            participants={snapshot.participants}
            meId={meId}
            onCycle={() =>
              void act(() =>
                send({ type: 'subticket.update', ticketId: ticket.id, subticketId: subticket.id, state: NEXT[subticket.state] }),
              )
            }
            onRename={(title) =>
              act(() => send({ type: 'subticket.update', ticketId: ticket.id, subticketId: subticket.id, title }))
            }
            onJoin={() => void act(() => send({ type: 'subticket.join', ticketId: ticket.id, subticketId: subticket.id }))}
            onLeave={() => void act(() => send({ type: 'subticket.leave', ticketId: ticket.id, subticketId: subticket.id }))}
            onRemove={() => void act(() => send({ type: 'subticket.remove', ticketId: ticket.id, subticketId: subticket.id }))}
          />
        ))}
      </ul>

      <div className="flex gap-2">
        <input
          className="field py-1 text-xs"
          placeholder="Add a subticket"
          value={draft}
          maxLength={200}
          disabled={!meId}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void add()
            }
          }}
        />
        <button className="btn" disabled={!draft.trim() || !meId} onClick={() => void add()}>
          add
        </button>
      </div>
      {error ? <p className="text-[11px] text-red-400">{error}</p> : null}
    </div>
  )
}

function Row({
  subticket,
  participants,
  meId,
  onCycle,
  onRename,
  onJoin,
  onLeave,
  onRemove,
}: {
  subticket: Subticket
  participants: Participant[]
  meId: string | null
  onCycle: () => void
  onRename: (title: string) => Promise<void>
  onJoin: () => void
  onLeave: () => void
  onRemove: () => void
}) {
  const [renaming, setRenaming] = useState(false)
  const [title, setTitle] = useState(subticket.title)
  const members = subticket.members
    .map((id) => participants.find((p) => p.id === id))
    .filter((p): p is Participant => Boolean(p))
  const mine = Boolean(meId && subticket.members.includes(meId as never))

  return (
    <li className="panel group space-y-1 px-2 py-1.5">
      <div className="flex items-start gap-2">
        <button
          className={`shrink-0 text-[11px] ${subticket.state === 'doing' ? 'text-sky-400' : subticket.state === 'done' ? 'text-accent' : 'text-mute'} hover:text-neutral-200`}
          title={`${subticket.state} -- click for ${NEXT[subticket.state]}`}
          onClick={onCycle}
        >
          {MARK[subticket.state]}
        </button>
        {renaming ? (
          <input
            className="field flex-1 py-0.5 text-xs"
            value={title}
            autoFocus
            maxLength={200}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={() => setRenaming(false)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setRenaming(false)
              if (event.key === 'Enter' && title.trim()) {
                event.preventDefault()
                void onRename(title.trim()).then(() => setRenaming(false))
              }
            }}
          />
        ) : (
          <span
            className={`min-w-0 flex-1 break-words text-xs ${TONE[subticket.state]}`}
            onDoubleClick={() => {
              setTitle(subticket.title)
              setRenaming(true)
            }}
            title="double-click to rename"
          >
            {subticket.title}
          </span>
        )}
        <button
          className="shrink-0 text-[11px] text-mute opacity-0 hover:text-red-400 group-hover:opacity-100"
          title="remove"
          onClick={onRemove}
        >
          ×
        </button>
      </div>
      <div className="flex items-center gap-2 pl-7">
        <div className="flex -space-x-1">
          {members.map((member) => (
            <span
              key={member.id}
              title={member.displayName}
              className={`h-2 w-2 rounded-full ring-1 ring-panel ${DOT[member.colorIndex % DOT.length]}`}
            />
          ))}
        </div>
        <span className="truncate text-[10px] text-mute">
          {members.map((m) => m.displayName).join(', ') || 'nobody on it'}
        </span>
        {meId ? (
          <button className="ml-auto text-[10px] text-mute hover:text-neutral-300" onClick={mine ? onLeave : onJoin}>
            {mine ? 'leave' : 'join'}
          </button>
        ) : null}
      </div>
    </li>
  )
}
