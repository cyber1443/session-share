'use client'

import { useState } from 'react'
import type { Attachment } from '@session-share/protocol'
import { usePicture } from '@/lib/files'

function Thumb({ slug, attachment, onOpen }: { slug: string; attachment: Attachment; onOpen: (url: string) => void }) {
  const url = usePicture(slug, attachment.id)
  return (
    <button
      className="group block overflow-hidden rounded border border-edge bg-neutral-900 text-left"
      onClick={() => url && onOpen(url)}
      title={attachment.caption || attachment.name}
    >
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={attachment.caption || attachment.name} className="h-24 w-full object-cover group-hover:opacity-90" />
      ) : (
        <div className="flex h-24 items-center justify-center text-[10px] text-mute">loading…</div>
      )}
      {attachment.caption ? <p className="truncate px-1.5 py-1 text-[10px] text-mute">{attachment.caption}</p> : null}
    </button>
  )
}

/** A grid of a ticket's pictures; clicking one shows it full size. */
export function Pictures({ slug, attachments }: { slug: string; attachments: Attachment[] }) {
  const [open, setOpen] = useState<string | null>(null)
  if (attachments.length === 0) return null
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        {attachments.map((attachment) => (
          <Thumb key={attachment.id} slug={slug} attachment={attachment} onOpen={setOpen} />
        ))}
      </div>
      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-8"
          onClick={() => setOpen(null)}
          role="dialog"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={open} alt="" className="max-h-full max-w-full rounded" />
        </div>
      ) : null}
    </>
  )
}
