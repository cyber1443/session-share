'use client'

import { useRef, useState, type ReactNode } from 'react'
import { TICKET_BODY_MAX, type SessionSnapshot, type Ticket } from '@session-share/protocol'
import type { Send } from '@/lib/live'
import { fromDateInput, toDateInput } from '@/lib/dates'
import { PICTURE_TYPES, uploadPicture, usePicture } from '@/lib/files'

/** A picture placed in a description: `![name](file:<attachment id>)`. */
const INLINE_PICTURE = /!\[([^\]]*)\]\(file:([\w-]+)\)/g

function InlinePicture({ slug, id, alt }: { slug: string; id: string; alt: string }) {
  const url = usePicture(slug, id)
  const [open, setOpen] = useState(false)
  if (!url) return <span className="block py-2 text-[10px] text-mute">loading {alt || 'picture'}…</span>
  return (
    <>
      <button className="my-1 block overflow-hidden rounded border border-edge" onClick={() => setOpen(true)} title={alt}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt={alt} className="max-h-64 max-w-full hover:opacity-90" />
      </button>
      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-8"
          onClick={() => setOpen(false)}
          role="dialog"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt={alt} className="max-h-full max-w-full rounded" />
        </div>
      ) : null}
    </>
  )
}

/** A description's text with its pasted pictures shown where they were put. */
function Body({ body, slug }: { body: string; slug: string }) {
  const parts: ReactNode[] = []
  let last = 0
  for (const match of body.matchAll(INLINE_PICTURE)) {
    if (match.index > last) parts.push(body.slice(last, match.index))
    parts.push(<InlinePicture key={match.index} slug={slug} id={match[2]!} alt={match[1]!} />)
    last = match.index + match[0].length
    // The picture is its own block; the line break that ended its token would be a blank line under it.
    if (body[last] === '\n') last += 1
  }
  parts.push(body.slice(last))
  return <div className="whitespace-pre-wrap break-words leading-relaxed text-neutral-400">{parts}</div>
}

/**
 * A ticket's title and description, editable in place. Anyone in the room
 * can reword a card -- the same people can delete it -- and once it has been
 * split the people building it are told the brief moved.
 */
export function Description({ ticket, slug, send }: { ticket: Ticket; slug: string; send: Send }) {
  const [editing, setEditing] = useState(false)
  const [uploading, setUploading] = useState(0)
  const area = useRef<HTMLTextAreaElement>(null)
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

  /**
   * A pasted or dropped picture is uploaded, attached to the ticket -- so the
   * agents get it with the brief -- and referenced where the cursor was.
   */
  const addPictures = async (files: File[]) => {
    setError(null)
    for (const file of files) {
      if (!PICTURE_TYPES.includes(file.type)) continue
      setUploading((n) => n + 1)
      try {
        const picture = await uploadPicture(slug, file)
        await send({ type: 'ticket.attach', ticketId: ticket.id, attachments: [picture] })
        const token = `![${picture.name.replace(/[\[\]]/g, '')}](file:${picture.id})`
        const at = area.current?.selectionStart ?? null
        setBody((current) => {
          const cut = at ?? current.length
          const before = current.slice(0, cut)
          const pad = before && !before.endsWith('\n') ? '\n' : ''
          return `${before}${pad}${token}\n${current.slice(cut)}`
        })
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : 'upload failed')
      } finally {
        setUploading((n) => n - 1)
      }
    }
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
          ref={area}
          className="field min-h-40 resize-y text-xs leading-relaxed"
          placeholder="What it is, why it matters, what done looks like. Paste or drop pictures here."
          value={body}
          maxLength={TICKET_BODY_MAX}
          disabled={busy}
          autoFocus
          onChange={(event) => setBody(event.target.value)}
          onPaste={(event) => {
            const files = [...event.clipboardData.files]
            if (files.some((file) => PICTURE_TYPES.includes(file.type))) {
              event.preventDefault()
              void addPictures(files)
            }
          }}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            const files = [...event.dataTransfer.files]
            if (files.length > 0) {
              event.preventDefault()
              void addPictures(files)
            }
          }}
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
            {uploading > 0 ? `uploading ${uploading} picture${uploading === 1 ? '' : 's'}… · ` : ''}
            {body.length.toLocaleString()} / {TICKET_BODY_MAX.toLocaleString()} · ⌘↵ saves
          </span>
          <button className="btn ml-auto" disabled={busy} onClick={() => setEditing(false)}>
            cancel
          </button>
          <button className="btn btn-accent" disabled={busy || uploading > 0 || !title.trim()} onClick={() => void save()}>
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
        <Body body={ticket.body} slug={slug} />
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
