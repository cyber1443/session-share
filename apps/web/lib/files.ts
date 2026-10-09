'use client'

import { useEffect, useState } from 'react'
import type { Attachment } from '@session-share/protocol'
import { peerToken } from './api'

export const PICTURE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

const auth = (): Record<string, string> => {
  const token = peerToken.get()
  return token ? { authorization: `Bearer ${token}` } : {}
}

/** Stores a picture with the session; the ticket then carries a reference to it. */
export async function uploadPicture(slug: string, file: File, kind: Attachment['kind'] = 'brief'): Promise<Attachment> {
  if (!PICTURE_TYPES.includes(file.type)) throw new Error(`${file.name}: only PNG, JPEG, GIF and WebP pictures.`)
  if (file.size > 10 * 1024 * 1024) throw new Error(`${file.name} is larger than 10 MB.`)
  const response = await fetch(`/sessions/${slug}/files`, {
    method: 'POST',
    headers: { 'content-type': file.type, 'x-file-name': encodeURIComponent(file.name || 'picture'), ...auth() },
    body: file,
  })
  const payload = (await response.json().catch(() => ({}))) as { id?: string; size?: number; message?: string }
  if (!response.ok || !payload.id) throw new Error(payload.message ?? `upload failed (${response.status})`)
  return { id: payload.id, name: file.name || 'picture', type: file.type, size: payload.size ?? file.size, kind, caption: '' }
}

/**
 * A picture as something an <img> can show. The file needs the seat's token,
 * which an <img src> cannot send, so it is fetched and shown from memory.
 */
export function usePicture(slug: string, id: string): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    let made: string | null = null
    fetch(`/sessions/${slug}/files/${id}`, { headers: auth() })
      .then((response) => (response.ok ? response.blob() : null))
      .then((blob) => {
        if (!blob || !live) return
        made = URL.createObjectURL(blob)
        setUrl(made)
      })
      .catch(() => undefined)
    return () => {
      live = false
      if (made) URL.revokeObjectURL(made)
    }
  }, [slug, id])
  return url
}
