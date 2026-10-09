import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { Attachment } from '@session-share/protocol'
import type { CommandTarget } from './client.js'
import { STATE_DIR } from './daemon.js'

const TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}
const EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
}

const auth = (config: CommandTarget): Record<string, string> =>
  config.participantToken ? { authorization: `Bearer ${config.participantToken}` } : {}

/** Stores a picture with the session and returns the reference a ticket carries. */
export async function uploadPicture(
  config: CommandTarget,
  path: string,
  kind: Attachment['kind'],
  caption = '',
): Promise<Attachment> {
  const type = TYPES[extname(path).toLowerCase()]
  if (!type) throw new Error(`${path}: only PNG, JPEG, GIF and WebP pictures can be attached.`)
  if (statSync(path).size > 10 * 1024 * 1024) throw new Error(`${path} is larger than 10 MB.`)
  const response = await fetch(new URL(`/sessions/${config.sessionRef}/files`, config.serverUrl), {
    method: 'POST',
    headers: { 'content-type': type, 'x-file-name': encodeURIComponent(basename(path)), ...auth(config) },
    body: readFileSync(path),
    signal: AbortSignal.timeout(30_000),
  })
  const payload = (await response.json()) as { id?: string; name?: string; size?: number; message?: string }
  if (!response.ok || !payload.id) throw new Error(payload.message ?? `upload failed (${response.status})`)
  return { id: payload.id, name: payload.name ?? basename(path), type, size: payload.size ?? 0, kind, caption }
}

/**
 * Saves a ticket's pictures where this machine's Claude can Read them. Named by
 * id, so asking twice costs nothing the second time.
 */
export async function downloadPictures(
  config: CommandTarget,
  attachments: Attachment[],
): Promise<Array<{ path: string; name: string; kind: string; caption: string }>> {
  const dir = join(STATE_DIR, 'files')
  mkdirSync(dir, { recursive: true })
  const saved = []
  for (const attachment of attachments) {
    const path = join(dir, `${attachment.id}${EXTENSIONS[attachment.type] ?? ''}`)
    try {
      statSync(path)
    } catch {
      const response = await fetch(
        new URL(`/sessions/${config.sessionRef}/files/${attachment.id}`, config.serverUrl),
        { headers: auth(config), signal: AbortSignal.timeout(30_000) },
      )
      if (!response.ok) continue
      writeFileSync(path, Buffer.from(await response.arrayBuffer()))
    }
    saved.push({ path, name: attachment.name, kind: attachment.kind, caption: attachment.caption })
  }
  return saved
}
