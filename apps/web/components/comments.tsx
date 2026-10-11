'use client'

import { useState } from 'react'
import type { Participant, SessionSnapshot, Ticket, TicketComment } from '@session-share/protocol'
import type { Send } from '@/lib/live'
import { ago } from '@/lib/now'
import { DOT } from '@/lib/palette'

/**
 * What has been said about this ticket, kept on the card. The room scrolls
 * away; a comment is what the next person to open the ticket -- or the agent
 * about to split it -- reads.
 */
export function Comments({
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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const comments = (snapshot.comments ?? []).filter((c) => c.ticketId === ticket.id)
  const me = snapshot.participants.find((p) => p.id === meId)

  const post = async () => {
    const body = draft.trim()
    if (!body) return
    setBusy(true)
    setError(null)
    try {
      await send({ type: 'comment.add', ticketId: ticket.id, body, asAgent: false })
      setDraft('')
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      {comments.length === 0 ? (
        <p className="leading-relaxed text-mute">
          Nothing said yet. Comments stay on the ticket, and whoever splits it is shown them.
        </p>
      ) : null}
      <ul className="space-y-3">
        {comments.map((comment) => {
          const author = snapshot.participants.find((p) => p.id === comment.authorId)
          // Someone with two checkouts wrote it either way.
          const own = Boolean(
            me && author && (author.id === me.id || (author.userId && author.userId === me.userId)),
          )
          return <Comment key={comment.id} comment={comment} author={author} own={own} send={send} />
        })}
      </ul>
      <div className="space-y-2">
        <textarea
          className="field min-h-20 resize-y text-xs leading-relaxed"
          placeholder="Say something about this ticket"
          value={draft}
          maxLength={8000}
          disabled={busy || !meId}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              void post()
            }
          }}
        />
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-mute">⌘↵ to comment</span>
          <button className="btn btn-accent" disabled={busy || !draft.trim() || !meId} onClick={() => void post()}>
            comment
          </button>
        </div>
        {error ? <p className="text-[11px] text-red-400">{error}</p> : null}
      </div>
    </div>
  )
}

function Comment({
  comment,
  author,
  own,
  send,
}: {
  comment: TicketComment
  author: Participant | undefined
  own: boolean
  send: Send
}) {
  const [editing, setEditing] = useState(false)
  const [body, setBody] = useState(comment.body)
  const [error, setError] = useState<string | null>(null)

  const act = async (fn: () => Promise<unknown>) => {
    setError(null)
    try {
      await fn()
      return true
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'failed')
      return false
    }
  }

  return (
    <li className="group space-y-1 border-l border-edge pl-2">
      <div className="flex items-center gap-2 text-[10px] text-mute">
        <span className={`h-1.5 w-1.5 rounded-full ${author ? DOT[author.colorIndex % DOT.length] : 'bg-neutral-700'}`} />
        <span className="text-neutral-300">
          {author?.displayName ?? 'someone'}
          {comment.byAgent ? "'s Claude" : ''}
        </span>
        <span title={new Date(comment.createdAt).toLocaleString()}>{ago(comment.createdAt)}</span>
        {comment.editedAt ? <span title={new Date(comment.editedAt).toLocaleString()}>· edited</span> : null}
        {own && !editing ? (
          <span className="ml-auto flex gap-2 opacity-0 group-hover:opacity-100">
            <button
              className="hover:text-neutral-300"
              onClick={() => {
                setBody(comment.body)
                setEditing(true)
              }}
            >
              edit
            </button>
            <button
              className="hover:text-red-400"
              onClick={() => void act(() => send({ type: 'comment.delete', commentId: comment.id }))}
            >
              delete
            </button>
          </span>
        ) : null}
      </div>
      {editing ? (
        <div className="space-y-1">
          <textarea
            className="field min-h-16 resize-y text-xs"
            value={body}
            autoFocus
            maxLength={8000}
            onChange={(event) => setBody(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setEditing(false)
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && body.trim()) {
                event.preventDefault()
                void act(() => send({ type: 'comment.edit', commentId: comment.id, body: body.trim() })).then(
                  (ok) => ok && setEditing(false),
                )
              }
            }}
          />
          <div className="flex justify-end gap-2">
            <button className="btn" onClick={() => setEditing(false)}>
              cancel
            </button>
            <button
              className="btn btn-accent"
              disabled={!body.trim()}
              onClick={() =>
                void act(() => send({ type: 'comment.edit', commentId: comment.id, body: body.trim() })).then(
                  (ok) => ok && setEditing(false),
                )
              }
            >
              save
            </button>
          </div>
        </div>
      ) : (
        <p className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-neutral-400">{comment.body}</p>
      )}
      {error ? <p className="text-[11px] text-red-400">{error}</p> : null}
    </li>
  )
}
