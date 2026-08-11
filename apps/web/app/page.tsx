'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { AuthProvider, SignIn, useAuth } from '@/components/auth'
import { JoinCode } from '@/components/join-code'
import { api, type SessionSummary } from '@/lib/api'

const PALETTE = [
  'bg-emerald-400',
  'bg-sky-400',
  'bg-amber-400',
  'bg-violet-400',
  'bg-rose-400',
  'bg-teal-400',
  'bg-orange-400',
  'bg-indigo-400',
]

function Sessions() {
  const { me, mode, logout } = useAuth()
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [creating, setCreating] = useState(false)
  const [pairing, setPairing] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const result = await api.sessions()
      setSessions(result.sessions)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'failed')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <header className="flex items-baseline justify-between border-b border-edge pb-4">
        <h1 className="text-sm uppercase tracking-wider">session-share</h1>
        <div className="flex items-center gap-4 text-xs text-mute">
          <span>{me?.displayName}</span>
          <button className="hover:text-neutral-300" onClick={() => void logout()}>
            sign out
          </button>
        </div>
      </header>

      <div className="mt-8 flex items-center justify-between">
        <h2 className="text-xs uppercase tracking-wider text-mute">Sessions</h2>
        <button className="btn btn-accent" onClick={() => setCreating(true)}>
          new session
        </button>
      </div>

      {error ? <p className="mt-4 text-xs text-red-400">{error}</p> : null}

      <ul className="mt-4 space-y-3">
        {sessions.map((session) => (
          <li key={session.id} className="panel p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <Link href={`/board?s=${session.slug}`} className="text-sm hover:text-accent">
                  {session.title}
                </Link>
                <p className="mt-1 truncate text-xs text-mute">
                  {session.repo.owner}/{session.repo.name} · {session.phase}
                  {session.issueRef ? ` · ${session.issueRef}` : ''}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <div className="flex -space-x-1">
                  {session.participants.map((participant) => (
                    <span
                      key={participant.id}
                      title={participant.displayName}
                      className={`h-2.5 w-2.5 rounded-full ring-2 ring-panel ${PALETTE[participant.colorIndex % PALETTE.length]} ${participant.connected ? '' : 'opacity-30'}`}
                    />
                  ))}
                </div>
                <button className="btn" onClick={() => setPairing(session.slug)}>
                  attach
                </button>
              </div>
            </div>

            {Object.keys(session.taskCounts).length > 0 ? (
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-edge pt-3 text-xs text-mute">
                {Object.entries(session.taskCounts).map(([state, count]) => (
                  <span key={state}>
                    {state} <span className="text-neutral-300">{count}</span>
                  </span>
                ))}
              </div>
            ) : null}
          </li>
        ))}
      </ul>

      {sessions.length === 0 ? (
        <p className="mt-6 text-xs text-mute">
          No sessions yet. Create one, then attach a checkout to it from Claude Code.
        </p>
      ) : null}

      {creating ? (
        <CreateSession
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false)
            void load()
          }}
        />
      ) : null}
      {pairing ? <JoinCode sessionRef={pairing} mode={mode} onClose={() => setPairing(null)} /> : null}
    </div>
  )
}

function CreateSession({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState('')
  const [slug, setSlug] = useState('')
  const [repo, setRepo] = useState('')
  const [issueRef, setIssueRef] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [owner, name] = repo.split('/')
  const valid = title.trim() && slug.trim() && owner && name

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.createSession({
        slug: slug.trim(),
        title: title.trim(),
        repo: {
          owner: owner!,
          name: name!,
          baseBranch: 'main',
          remoteUrl: `git@github.com:${owner}/${name}.git`,
        },
        issueRef: issueRef.trim() || null,
      })
      onCreated()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-6" onClick={onClose}>
      <div className="panel w-full max-w-lg space-y-4 p-6" onClick={(event) => event.stopPropagation()}>
        <h2 className="text-sm uppercase tracking-wider">New session</h2>

        <label className="block space-y-1">
          <span className="text-xs text-mute">What are you building</span>
          <input
            className="field"
            placeholder="Add a dark mode toggle"
            value={title}
            onChange={(event) => {
              setTitle(event.target.value)
              if (!slug) {
                setSlug(
                  event.target.value
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, '-')
                    .replace(/^-|-$/g, '')
                    .slice(0, 40),
                )
              }
            }}
          />
        </label>

        <label className="block space-y-1">
          <span className="text-xs text-mute">Slug</span>
          <input className="field" value={slug} onChange={(event) => setSlug(event.target.value)} />
        </label>

        <label className="block space-y-1">
          <span className="text-xs text-mute">Repository</span>
          <input
            className="field"
            placeholder="acme/web"
            value={repo}
            onChange={(event) => setRepo(event.target.value)}
          />
        </label>

        <label className="block space-y-1">
          <span className="text-xs text-mute">Issue (optional)</span>
          <input
            className="field"
            placeholder="https://github.com/acme/web/issues/42"
            value={issueRef}
            onChange={(event) => setIssueRef(event.target.value)}
          />
        </label>

        {error ? <p className="text-xs text-red-400">{error}</p> : null}

        <div className="flex justify-end gap-2 pt-2">
          <button className="btn" onClick={onClose}>
            cancel
          </button>
          <button className="btn btn-accent" disabled={!valid || busy} onClick={() => void submit()}>
            {busy ? 'creating…' : 'create'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Gate() {
  const { me, mode, loading } = useAuth()

  /**
   * A peer server has no account to land on and no list to browse -- it hosts
   * one session per invite. Send people straight to the board, which knows how
   * to redeem an invite or resume with the token it already holds.
   */
  useEffect(() => {
    if (loading || mode !== 'peer') return
    const invite = new URLSearchParams(window.location.search).get('join')
    window.location.replace(invite ? `/board?join=${encodeURIComponent(invite)}` : '/board')
  }, [loading, mode])

  if (loading || mode === 'peer') return <div className="p-6 text-xs text-mute">…</div>
  return me ? <Sessions /> : <SignIn />
}

export default function Home() {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  )
}
