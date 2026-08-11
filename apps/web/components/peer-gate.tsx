'use client'

import { useEffect, useState } from 'react'
import { unpackInvite } from '@session-share/protocol'
import { api, peerToken } from '@/lib/api'
import { stripQueryParam, useQueryParam } from '@/lib/query'

export interface PeerSeat {
  sessionRef: string
  displayName: string
}

/**
 * Peer mode's entire sign-in: an invite in the URL and a name to be known by.
 * Nothing is verified -- the invite is the credential -- so this asks for the
 * one thing it genuinely needs and gets out of the way.
 */
export function PeerGate({ onSeated }: { onSeated: (seat: PeerSeat) => void }) {
  const { value: invite, ready } = useQueryParam('join')
  /**
   * When the plugin opened this page it already knows who you are -- it just
   * joined the session as you. Asking again would make "the board opens by
   * itself" mean "the board opens and then asks you a question".
   */
  const { value: known, ready: knownReady } = useQueryParam('as')
  const [handle, setHandle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [seating, setSeating] = useState(false)

  useEffect(() => {
    setHandle(window.localStorage.getItem('session-share.handle') ?? '')
  }, [])

  const join = async (as?: string) => {
    const name = (as ?? handle).trim()
    if (!invite || !name) return
    setBusy(true)
    setError(null)
    try {
      /**
       * The link carries the packed form, which also names the server. This
       * page is served BY that server, so only the token inside matters here.
       */
      const token = unpackInvite(invite)?.token ?? invite
      const result = await api.peerJoin(token, { githubLogin: name, displayName: name })
      peerToken.set(result.participantToken)
      window.localStorage.setItem('session-share.handle', name)
      stripQueryParam('join')
      stripQueryParam('as')
      onSeated({ sessionRef: result.sessionRef, displayName: result.displayName })
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'could not join')
    } finally {
      setBusy(false)
      setSeating(false)
    }
  }

  // Seat the known handle once, and fall back to the form if it is refused.
  useEffect(() => {
    if (!ready || !knownReady || seating) return
    if (!invite || !known?.trim()) return
    setSeating(true)
    void join(known)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, knownReady, invite, known])

  if (!ready || !knownReady) return <div className="p-6 text-xs text-mute">…</div>
  if (seating && !error) return <div className="p-6 text-xs text-mute">joining as {known}…</div>

  if (!invite) {
    return (
      <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-6">
        <h1 className="text-lg tracking-tight">session-share</h1>
        <p className="text-sm leading-relaxed text-mute">
          This server hosts peer sessions. Open the invite link a teammate sent you, or run
          <code className="mx-1 text-neutral-400">/ss:host</code> in Claude Code to start one.
        </p>
      </div>
    )
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-6">
      <div>
        <h1 className="text-lg tracking-tight">Join the session</h1>
        <p className="mt-2 text-sm leading-relaxed text-mute">
          Your name is how the others tell you apart. Use the same handle you use in Claude Code and
          your browser seat and your checkout become one participant.
        </p>
      </div>

      <input
        className="field"
        placeholder="github handle, e.g. alice"
        value={handle}
        autoFocus
        onChange={(event) => setHandle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && handle.trim()) void join()
        }}
      />

      <button
        className="btn btn-accent"
        disabled={!handle.trim() || busy}
        onClick={() => void join()}
      >
        {busy ? 'joining…' : 'join'}
      </button>

      {error ? <p className="text-xs text-red-400">{error}</p> : null}

      <p className="text-xs leading-relaxed text-mute">
        Nothing here is verified. Whoever holds this invite is in the room — which is the right trade
        for a private session and the wrong one for a public link.
      </p>
    </div>
  )
}
