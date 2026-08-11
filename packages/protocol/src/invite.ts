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
  /**
   * Which server minted it. A guest dials `url` before it can check anything,
   * and `url` may well resolve to a *different* session-share on their own
   * machine -- most obviously when the host handed out a loopback address. With
   * this the guest can say "you reached the wrong server" instead of the server
   * saying "this invite is invalid", which is the same failure described from
   * the one end that cannot explain it.
   */
  serverId?: string | null
}

export function packInvite(invite: PackedInvite): string {
  const payload = JSON.stringify({
    u: invite.url.replace(/\/$/, ''),
    t: invite.token,
    ...(invite.serverId ? { s: invite.serverId } : {}),
  })
  return INVITE_PREFIX + base64UrlEncode(payload)
}

/**
 * Finds the invite inside whatever was pasted. People paste the board URL, or
 * the whole `/ss:join ssx_…` line, or the invite with a trailing `&as=alice`
 * from a copied link -- all of which carry a perfectly good invite that a
 * strict parser would reject.
 */
export function findInvite(value: string): string | null {
  return value.match(/ssx_[A-Za-z0-9_-]+/)?.[0] ?? null
}

export function unpackInvite(value: string): PackedInvite | null {
  const body = findInvite(value)?.slice(INVITE_PREFIX.length) ?? null
  if (!body) return null

  try {
    const parsed = JSON.parse(base64UrlDecode(body)) as { u?: unknown; t?: unknown; s?: unknown }
    if (typeof parsed.u !== 'string' || typeof parsed.t !== 'string') return null
    if (!/^https?:\/\//.test(parsed.u)) return null
    return {
      url: parsed.u,
      token: parsed.t,
      // Older invites do not carry one; absence means "cannot check", not "mismatch".
      serverId: typeof parsed.s === 'string' ? parsed.s : null,
    }
  } catch {
    return null
  }
}

/**
 * An invite pointing here is only ever usable on the machine that minted it --
 * on anyone else's it addresses their own server. Worth catching before it is
 * handed out, not after someone fails to join.
 */
export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '')
    return host === 'localhost' || host === '::1' || host.startsWith('127.')
  } catch {
    return false
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
