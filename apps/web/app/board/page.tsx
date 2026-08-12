'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { chooseSeat, type Participant, type Task } from '@session-share/protocol'
import { AuthProvider, SignIn, useAuth } from '@/components/auth'
import { PeerGate } from '@/components/peer-gate'
import { api, peerToken } from '@/lib/api'
import { useQueryParam } from '@/lib/query'
import { JoinCode } from '@/components/join-code'
import { Kanban } from '@/components/kanban'
import { Room } from '@/components/room'
import { TicketPanel } from '@/components/ticket'
import { useLiveSession } from '@/lib/live'
import { tokens } from '@/lib/tokens'

const DOT = [
  'bg-emerald-400',
  'bg-sky-400',
  'bg-amber-400',
  'bg-violet-400',
  'bg-rose-400',
  'bg-teal-400',
  'bg-orange-400',
  'bg-indigo-400',
]

const PHASES = ['plan', 'build', 'integrate', 'done'] as const


function Board({ slug }: { slug: string }) {
  const { me, mode } = useAuth()
  const { snapshot, status, error, activity, events, send } = useLiveSession(slug)
  const [openTicket, setOpenTicket] = useState<string | null>(null)
  const [chatFilter, setChatFilter] = useState<string | null>(null)
  const [pairing, setPairing] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  if (error && !snapshot) {
    return (
      <div className="p-8 text-xs text-red-400">
        {error} · <Link href="/" className="underline">back</Link>
      </div>
    )
  }
  if (!snapshot) return <div className="p-8 text-xs text-mute">connecting…</div>

  const mine = snapshot.participants.find((p) => p.userId === me?.id)
  const pendingHandoffs = snapshot.handoffs.filter(
    (h) => h.status === 'pending' && h.holderId === mine?.id,
  )
  /**
   * One view. The board is the session: a ticket card opens into everything
   * about it, which is where the graph and the DAG used to send you.
   */
  const ticket = snapshot.tickets.find((t) => t.id === openTicket) ?? null

  const act = async (fn: () => Promise<unknown>) => {
    setActionError(null)
    try {
      await fn()
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : 'failed')
    }
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-edge px-4 py-2">
        <div className="flex items-baseline gap-3">
          <Link href="/" className="text-xs text-mute hover:text-neutral-300">
            ←
          </Link>
          <h1 className="text-sm">{snapshot.session.title}</h1>
          <span className="text-xs text-mute">
            {snapshot.session.repo.owner}/{snapshot.session.repo.name}
          </span>
        </div>
        <div className="flex items-center gap-4 text-xs">
          <span
            className={
              status === 'live'
                ? 'text-accent'
                : status === 'reconnecting'
                  ? 'text-amber-400'
                  : 'text-mute'
            }
          >
            {status}
          </span>
          {!mine?.repoPath ? (
            <button className="btn" onClick={() => setPairing(true)}>
              attach checkout
            </button>
          ) : null}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* rail */}
        <aside className="flex w-56 shrink-0 flex-col gap-6 border-r border-edge p-4">
          <div>
            <p className="text-[10px] uppercase tracking-wider text-mute">Phase</p>
            <div className="mt-2 space-y-1">
              {PHASES.map((phase) => (
                <div
                  key={phase}
                  className={`text-xs ${phase === snapshot.session.phase ? 'text-accent' : 'text-mute'}`}
                >
                  {phase === snapshot.session.phase ? '▸ ' : '  '}
                  {phase}
                </div>
              ))}
            </div>
          </div>

          <div>
            <p className="text-[10px] uppercase tracking-wider text-mute">Who</p>
            <ul className="mt-2 space-y-2">
              {snapshot.participants.map((participant) => (
                <li key={participant.id} className="text-xs">
                  <div className="flex items-center gap-2">
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${DOT[participant.colorIndex % DOT.length]} ${participant.connected ? '' : 'opacity-30'}`}
                    />
                    <span className="truncate text-neutral-300">{participant.displayName}</span>
                  </div>
                  <p className="mt-0.5 truncate pl-4 text-[10px] text-mute">
                    {participant.activity.detail}
                    {participant.repoPath ? '' : ' · watching'}
                  </p>
                  {/* What their own Claude account has spent on this session. */}
                  {(() => {
                    const spent = snapshot.usage
                      .filter((u) => u.participantId === participant.id)
                      .reduce((sum, u) => sum + u.inputTokens + u.outputTokens, 0)
                    return spent > 0 ? (
                      <p className="truncate pl-4 text-[10px] text-mute">{tokens(spent)} tokens</p>
                    ) : null
                  })()}

                  {/* What they were given, and how much of it is done. */}
                  {(() => {
                    const theirs = snapshot.tasks.filter((t) => t.assigneeId === participant.id)
                    if (theirs.length === 0) return null
                    const merged = theirs.filter((t) => t.state === 'merged').length
                    return (
                      <p className="truncate pl-4 text-[10px] text-mute">
                        {merged}/{theirs.length} landed
                      </p>
                    )
                  })()}
                </li>
              ))}
            </ul>
          </div>

          {pendingHandoffs.map((handoff) => (
            <div key={handoff.id} className="panel space-y-2 p-3">
              <p className="text-[10px] uppercase tracking-wider text-amber-400">Handoff asked</p>
              <p className="break-all text-xs text-neutral-300">{handoff.path}</p>
              {handoff.reason ? <p className="text-[10px] text-mute">{handoff.reason}</p> : null}
              <div className="flex gap-2">
                <button
                  className="btn flex-1"
                  onClick={() =>
                    void act(() =>
                      send({ type: 'handoff.resolve', requestId: handoff.id, granted: false }),
                    )
                  }
                >
                  no
                </button>
                <button
                  className="btn btn-accent flex-1"
                  onClick={() =>
                    void act(() =>
                      send({ type: 'handoff.resolve', requestId: handoff.id, granted: true }),
                    )
                  }
                >
                  grant
                </button>
              </div>
            </div>
          ))}

          {actionError ? <p className="text-xs text-red-400">{actionError}</p> : null}
        </aside>

        {/* the board + the room */}
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="relative min-h-0 flex-1 border-b border-edge">
            <Kanban
              snapshot={snapshot}
              meId={mine?.id ?? null}
              selected={openTicket}
              onCreate={(title, body) => act(() => send({ type: 'ticket.create', title, body }))}
              onJoin={(ticketId) =>
                act(() => send({ type: 'ticket.join', ticketId: ticketId as never }))
              }
              onOpen={(ticketId) => setOpenTicket(ticketId === openTicket ? null : ticketId)}
            />
          </div>
          <div className="h-64 shrink-0">
            <Room
              snapshot={snapshot}
              events={events}
              filterTaskId={chatFilter}
              onClearFilter={() => setChatFilter(null)}
              onPost={async (body, directive) => {
                await send({ type: 'chat.post', body, taskRef: null, asAgent: false, directive })
              }}
            />
          </div>
        </main>

        {ticket ? (
          <TicketPanel
            ticket={ticket}
            snapshot={snapshot}
            meId={mine?.id ?? null}
            activity={activity}
            onClose={() => setOpenTicket(null)}
            onJoin={() => act(() => send({ type: 'ticket.join', ticketId: ticket.id }))}
            onLeave={() => act(() => send({ type: 'ticket.leave', ticketId: ticket.id }))}
            onStart={() => act(() => send({ type: 'ticket.start', ticketId: ticket.id }))}
            onApprove={() => act(() => send({ type: 'ticket.approve', ticketId: ticket.id }))}
            onAssign={(taskId, participantId) =>
              act(() =>
                send({
                  type: 'task.assign',
                  taskId: taskId as never,
                  participantId: participantId as never,
                }),
              )
            }
            // Closing first: the panel is about to be describing a card that
            // no longer exists.
            onDelete={() =>
              act(async () => {
                setOpenTicket(null)
                await send({ type: 'ticket.delete', ticketId: ticket.id })
              })
            }
          />
        ) : null}
      </div>

      {pairing ? <JoinCode sessionRef={slug} mode={mode} onClose={() => setPairing(false)} /> : null}
    </div>
  )
}

function Gate() {
  const { me, mode, loading, refresh } = useAuth()
  const { value: slug, ready } = useQueryParam('s')
  const { value: invite, ready: inviteReady } = useQueryParam('join')
  const [peerSlug, setPeerSlug] = useState<string | null>(null)
  const [resolving, setResolving] = useState(false)

  /**
   * An invite in the URL beats a token in local storage. Both are credentials
   * and they can name different sessions -- and preferring the stored one shows
   * the session this browser opened last, complete with its chat and its
   * participants, while ignoring the link someone just followed.
   */
  const seated = ready && inviteReady && !peerSlug
  const seat = seated ? chooseSeat({ invite, hasToken: Boolean(peerToken.get()) }) : null

  /** A returning visitor's token is scoped to one session; the server says which. */
  useEffect(() => {
    if (loading || mode !== 'peer' || seat?.kind !== 'stored' || slug) return

    setResolving(true)
    api
      .sessions()
      .then((result) => setPeerSlug(result.sessions[0]?.slug ?? null))
      .catch(() => peerToken.clear())
      .finally(() => setResolving(false))
  }, [loading, mode, seat?.kind, slug])

  if (loading || !ready || !inviteReady || resolving) {
    return <div className="p-6 text-xs text-mute">…</div>
  }

  // A peer board is authorised by the token it holds, not by an account.
  if (mode === 'peer') {
    const seated = peerSlug ?? (seat?.kind === 'stored' ? slug : null)
    /**
     * Redeeming the invite is what gives this browser an identity, and the
     * identity was fetched before that happened -- so ask again. Without this
     * the board is seated but does not know which participant it is, and every
     * "is this mine" control stays disabled: approving, granting a handoff,
     * seeing your own tasks.
     */
    if (!seated) {
      return (
        <PeerGate
          onSeated={(seat) => {
            setPeerSlug(seat.sessionRef)
            void refresh()
          }}
        />
      )
    }
    return <Board slug={seated} />
  }

  if (!me) return <SignIn />
  if (!slug) return <div className="p-6 text-xs text-mute">No session selected.</div>
  return <Board slug={slug} />
}

export default function SessionPage() {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  )
}
