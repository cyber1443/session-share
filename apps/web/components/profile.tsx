'use client'

import { useState } from 'react'
import { USAGE_WEIGHT, usageDay, weightedUnits, type SessionSnapshot } from '@session-share/protocol'
import type { Send } from '@/lib/live'
import { tokens } from '@/lib/tokens'

/** One click sets a sensible limit; anything else goes in the field. */
const PRESETS = [250_000, 1_000_000, 5_000_000, 20_000_000]

/** Accepts `500k`, `2.5M` or a plain number. */
function parseUnits(text: string): number | null {
  const match = /^\s*([\d.,]+)\s*([kKmM]?)\s*$/.exec(text)
  if (!match) return null
  const n = Number(match[1]!.replace(/,/g, ''))
  if (!Number.isFinite(n)) return null
  const scale = match[2]!.toLowerCase() === 'm' ? 1_000_000 : match[2]!.toLowerCase() === 'k' ? 1_000 : 1
  return Math.round(n * scale)
}

/** The next 00:00 UTC, in the viewer's own clock. */
function resetsAt(now = Date.now()): string {
  const next = new Date(now)
  next.setUTCHours(24, 0, 0, 0)
  return next.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/**
 * One person in the session: who they are, where they work from, what their
 * Claude has spent here, and -- on your own -- the daily limit you set on it.
 * Seats are per checkout; this is per login, so a person with a board and two
 * clones is one profile with one limit.
 */
export function ProfilePanel({
  login,
  snapshot,
  isMe,
  send,
  onClose,
}: {
  login: string
  snapshot: SessionSnapshot
  isMe: boolean
  send: Send
  onClose: () => void
}) {
  const key = login.toLowerCase()
  const seats = snapshot.participants.filter((p) => p.githubLogin.toLowerCase() === key)
  const person = seats[0]
  const profile = snapshot.profiles.find((p) => p.login === key) ?? null
  const limit = profile?.dailyLimit ?? null
  const today = snapshot.spentToday.find((s) => s.login === key && s.day === usageDay(Date.now()))?.units ?? 0
  const seatIds = new Set(seats.map((s) => s.id))
  const total = snapshot.usage.filter((u) => seatIds.has(u.participantId)).reduce((sum, u) => sum + weightedUnits(u), 0)
  const turns = snapshot.usage.filter((u) => seatIds.has(u.participantId)).reduce((sum, u) => sum + u.turns, 0)
  const over = limit !== null && today >= limit
  const outOfUsage = seats.some((s) => snapshot.limited?.includes(s.id)) && !over

  const [draft, setDraft] = useState(limit === null ? '' : tokens(limit))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async (value: number | null) => {
    setError(null)
    setSaving(true)
    try {
      await send({ type: 'profile.update', dailyLimit: value })
      setDraft(value === null ? '' : tokens(value))
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'failed')
    } finally {
      setSaving(false)
    }
  }

  const submit = () => {
    if (!draft.trim()) return void save(null)
    const value = parseUnits(draft)
    if (value === null || value < 1_000) {
      setError('Enter a number of at least 1k, like 500k or 2M.')
      return
    }
    void save(value)
  }

  if (!person) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-6" onClick={onClose}>
      <div className="panel w-full max-w-lg space-y-5 p-6" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center gap-4">
          {person.avatarUrl ? (
            <img src={person.avatarUrl} alt="" className="h-12 w-12 rounded-full border border-edge" />
          ) : (
            <div className="flex h-12 w-12 items-center justify-center rounded-full border border-edge text-sm text-mute">
              {person.displayName.slice(0, 1).toUpperCase()}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm text-neutral-200">{person.displayName}</h2>
            <p className="text-xs text-mute">
              @{person.githubLogin}
              {snapshot.session.leadId && seatIds.has(snapshot.session.leadId) ? ' · lead' : ''}
              {isMe ? ' · you' : ''}
            </p>
          </div>
          <button className="btn" onClick={onClose}>
            close
          </button>
        </div>

        <div>
          <p className="text-[10px] uppercase tracking-wider text-mute">Seats</p>
          <ul className="mt-2 space-y-1 text-xs">
            {seats.map((seat) => {
              const mode = snapshot.autopilots?.[seat.id]
              return (
                <li key={seat.id} className="flex justify-between gap-3 text-neutral-300">
                  <span className="truncate">
                    {seat.repoPath ? seat.repoPath.split('/').filter(Boolean).at(-1) : 'board only'}
                  </span>
                  <span className="shrink-0 text-mute">
                    {seat.connected ? 'online' : 'away'}
                    {mode ? ` · autopilot ${mode}` : seat.repoPath ? ' · Claude Code closed' : ''}
                  </span>
                </li>
              )
            })}
          </ul>
        </div>

        <div>
          <p className="text-[10px] uppercase tracking-wider text-mute">Today (UTC)</p>
          <p className="mt-2 text-xs text-neutral-300">
            {tokens(Math.round(today))}
            {limit !== null ? ` of ${tokens(limit)}` : ''} units
            <span className="text-mute"> · {tokens(Math.round(total))} units, {turns} turns all time</span>
          </p>
          {limit !== null ? (
            <div className="mt-2 h-1.5 w-full bg-edge">
              <div
                className={over ? 'h-full bg-amber-400' : 'h-full bg-accent'}
                style={{ width: `${Math.min(100, (today / limit) * 100)}%` }}
              />
            </div>
          ) : null}
          {over ? (
            <p className="mt-2 text-xs text-amber-400">
              Daily limit reached. Nothing new is handed to {isMe ? 'you' : 'them'} until {resetsAt()}.
            </p>
          ) : null}
          {outOfUsage ? <p className="mt-2 text-xs text-amber-400">Their Claude account is out of usage.</p> : null}
        </div>

        {isMe ? (
          <div className="space-y-2 border-t border-edge pt-4">
            <p className="text-[10px] uppercase tracking-wider text-mute">Daily token limit</p>
            <div className="flex flex-wrap gap-2">
              {PRESETS.map((preset) => (
                <button
                  key={preset}
                  className={`btn ${limit === preset ? 'btn-accent' : ''}`}
                  disabled={saving}
                  onClick={() => void save(preset)}
                >
                  {tokens(preset)}
                </button>
              ))}
              <button className={`btn ${limit === null ? 'btn-accent' : ''}`} disabled={saving} onClick={() => void save(null)}>
                none
              </button>
            </div>
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                submit()
              }}
            >
              <input
                className="field"
                placeholder="custom, e.g. 750k or 3M"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                aria-label="daily token limit"
              />
              <button className="btn btn-accent" type="submit" disabled={saving}>
                save
              </button>
            </form>
            {error ? <p className="text-xs text-red-400">{error}</p> : null}
            <p className="text-[11px] leading-relaxed text-mute">
              Counts everything your Claude spends on this session, at the keyboard and on autopilot, in the
              usage tab&apos;s weighted units (output ×{USAGE_WEIGHT.output}, cache write ×{USAGE_WEIGHT.cacheWrite},
              cache read ×{USAGE_WEIGHT.cacheRead}). Once it is reached, your unstarted tasks go to a teammate,
              autopilot stops and the room stops handing your agent work until 00:00 UTC ({resetsAt()} your time).
              What you type yourself is never blocked.
            </p>
          </div>
        ) : limit !== null ? (
          <p className="border-t border-edge pt-4 text-xs text-mute">
            Daily limit: {tokens(limit)} units, set by {person.displayName}.
          </p>
        ) : null}
      </div>
    </div>
  )
}
