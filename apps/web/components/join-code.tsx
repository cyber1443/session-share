'use client'

import { useEffect, useState } from 'react'
import { packInvite } from '@session-share/protocol'
import { api } from '@/lib/api'

/**
 * The pairing half of signing in. Identity comes from GitHub in this browser;
 * this hands that identity to a checkout on some machine, without anyone typing
 * a server URL or an id.
 */
export function JoinCode({
  sessionRef,
  mode,
  onClose,
}: {
  sessionRef: string
  mode: 'oauth' | 'peer'
  onClose: () => void
}) {
  const [token, setToken] = useState<string | null>(null)
  const [expiresAt, setExpiresAt] = useState<number>(0)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    /**
     * Peer sessions hand out the invite itself -- reusable, and it names the
     * server so nobody has to be told an address. Hosted sessions mint a
     * single-use code instead, because there identity is worth protecting.
     */
    const request = mode === 'peer' ? api.invite(sessionRef) : api.joinToken(sessionRef)
    request
      .then((result) => {
        setToken('invite' in result ? packInvite({ url: window.location.origin, token: result.invite }) : result.token)
        setExpiresAt('expiresAt' in result ? result.expiresAt : 0)
      })
      .catch((failure: Error) => setError(failure.message))
  }, [sessionRef, mode])

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const expires = expiresAt > 0
  const remaining = expires ? Math.max(0, expiresAt - now) : Infinity
  const minutes = Math.floor(remaining / 60000)
  const seconds = Math.floor((remaining % 60000) / 1000)
  const command = token ? `/ss:join ${token}` : ''

  const copy = async () => {
    await navigator.clipboard.writeText(command)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-6"
      onClick={onClose}
    >
      <div
        className="panel w-full max-w-xl space-y-5 p-6"
        onClick={(event) => event.stopPropagation()}
      >
        <div>
          <h2 className="text-sm uppercase tracking-wider">Attach a checkout</h2>
          <p className="mt-2 text-xs leading-relaxed text-mute">
            Run this in Claude Code, inside the clone you want to work in. It pairs that checkout to
            your GitHub identity and turns on the lease gate.
          </p>
        </div>

        {error ? <p className="text-xs text-red-400">{error}</p> : null}

        {token ? (
          <>
            <div className="scroll-x panel bg-ink p-4">
              <code className="whitespace-nowrap text-sm text-accent">{command}</code>
            </div>

            <div className="flex items-center justify-between gap-4">
              <p className="text-xs text-mute">
                {!expires ? (
                  <>anyone with this can join · reusable</>
                ) : remaining > 0 ? (
                  <>
                    single use · expires in {minutes}:{String(seconds).padStart(2, '0')}
                  </>
                ) : (
                  <span className="text-red-400">expired — close and generate another</span>
                )}
              </p>
              <div className="flex gap-2">
                <button className="btn" onClick={onClose}>
                  close
                </button>
                <button className="btn btn-accent" onClick={() => void copy()} disabled={expires && remaining === 0}>
                  {copied ? 'copied' : 'copy'}
                </button>
              </div>
            </div>

            <p className="border-t border-edge pt-4 text-xs leading-relaxed text-mute">
              Each participant needs their own clone or <code>git worktree</code>. Two Claude Codes
              in one working tree corrupt each other&apos;s edits, and no lease can prevent that —
              the server will refuse the second one.
            </p>
          </>
        ) : (
          <p className="text-xs text-mute">generating…</p>
        )}
      </div>
    </div>
  )
}
