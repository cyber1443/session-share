/**
 * A join string carries both halves of what a guest needs: where the session
 * lives and the token that gets them in. One opaque string pastes cleanly into
 * a terminal, a chat message or a URL -- asking someone for "the address and
 * the token" is how setups start feeling like configuration.
 */
export const INVITE_PREFIX = 'ssx_'

export interface PackedInvite {
  /** Origin of the hosting machine, e.g. http://192.168.1.24:4310 */
  url: string
  /** The signed invite the server issued. */
  token: string
}

export function packInvite(invite: PackedInvite): string {
  const payload = JSON.stringify({ u: invite.url.replace(/\/$/, ''), t: invite.token })
  return INVITE_PREFIX + base64UrlEncode(payload)
}

export function unpackInvite(value: string): PackedInvite | null {
  const trimmed = value.trim()
  const body = trimmed.startsWith(INVITE_PREFIX) ? trimmed.slice(INVITE_PREFIX.length) : null
  if (!body) return null

  try {
    const parsed = JSON.parse(base64UrlDecode(body)) as { u?: unknown; t?: unknown }
    if (typeof parsed.u !== 'string' || typeof parsed.t !== 'string') return null
    if (!/^https?:\/\//.test(parsed.u)) return null
    return { url: parsed.u, token: parsed.t }
  } catch {
    return null
  }
}

// Works in Node and in the browser without pulling in a polyfill either way.
function base64UrlEncode(value: string): string {
  const bytes =
    typeof Buffer !== 'undefined'
      ? Buffer.from(value, 'utf8').toString('base64')
      : btoa(String.fromCharCode(...new TextEncoder().encode(value)))
  return bytes.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlDecode(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  if (typeof Buffer !== 'undefined') return Buffer.from(padded, 'base64').toString('utf8')
  return new TextDecoder().decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)))
}
