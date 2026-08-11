'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import type { Task } from '@session-share/protocol'
import { AuthProvider, SignIn, useAuth } from '@/components/auth'
import { PeerGate } from '@/components/peer-gate'
import { api, peerToken } from '@/lib/api'
import { useQueryParam } from '@/lib/query'
import { Dag } from '@/components/dag'
import { Graph } from '@/components/graph'
import { JoinCode } from '@/components/join-code'
import { Room } from '@/components/room'
import { useLiveSession } from '@/lib/live'

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
  const [selected, setSelected] = useState<string | null>(null)
  /** Topics answers "what is this about"; order answers "what unblocks what". */
  const [view, setView] = useState<'graph' | 'dag'>('graph')
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
  const selectedTask = snapshot.tasks.find((t) => t.id === selected) ?? null
  const pendingHandoffs = snapshot.handoffs.filter(
    (h) => h.status === 'pending' && h.holderId === mine?.id,
  )
  const decomposition = snapshot.decomposition
  const awaitingApproval = decomposition?.status === 'proposed' && snapshot.validation?.ok

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
                </li>
              ))}
            </ul>
          </div>

          {awaitingApproval ? (
            <div className="panel space-y-2 p-3">
              <p className="text-[10px] uppercase tracking-wider text-mute">Split proposed</p>
              <p className="text-xs leading-relaxed text-neutral-300">
                {decomposition!.tasks.length} tasks, up to {snapshot.validation!.maxFrontier} at once.
              </p>
              <button
                className="btn btn-accent w-full"
                disabled={!mine || decomposition!.approvals.includes(mine.id)}
                onClick={() =>
                  void act(() =>
                    send({ type: 'decomposition.approve', decompositionId: decomposition!.id }),
                  )
                }
              >
                {mine && decomposition!.approvals.includes(mine.id) ? 'approved' : 'approve'}
              </button>
            </div>
          ) : null}

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

        {/* graph + room */}
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="relative min-h-0 flex-1 border-b border-edge">
            <div className="absolute right-3 top-3 z-10 flex gap-3 text-[10px] uppercase tracking-wider">
              <button
                className={view === 'graph' ? 'text-neutral-200' : 'text-mute hover:text-neutral-400'}
                onClick={() => setView('graph')}
              >
                topics
              </button>
              <button
                className={view === 'dag' ? 'text-neutral-200' : 'text-mute hover:text-neutral-400'}
                onClick={() => setView('dag')}
              >
                order
              </button>
            </div>

            {view === 'graph' ? (
              <Graph
                tasks={snapshot.tasks}
                contract={snapshot.decomposition?.contract ?? null}
                participants={snapshot.participants}
                activity={activity}
                selected={selected}
                onSelect={(taskId) => setSelected(taskId === selected ? null : taskId)}
              />
            ) : (
              <Dag
                tasks={snapshot.tasks}
                participants={snapshot.participants}
                activity={activity}
                selected={selected}
                onSelect={(taskId) => setSelected(taskId === selected ? null : taskId)}
              />
            )}
          </div>
          <div className="h-64 shrink-0">
            <Room
              snapshot={snapshot}
              events={events}
              filterTaskId={chatFilter}
              onClearFilter={() => setChatFilter(null)}
              onPost={async (body) => {
                await send({ type: 'chat.post', body, taskRef: null, asAgent: false })
              }}
            />
          </div>
        </main>

        {/* drawer */}
        {selectedTask ? (
          <TaskDrawer
            task={selectedTask}
            ownerName={
              snapshot.participants.find((p) => p.id === selectedTask.ownerId)?.displayName ?? null
            }
            onClose={() => setSelected(null)}
            onFilterChat={() => setChatFilter(selectedTask.id)}
          />
        ) : null}
      </div>

      {pairing ? <JoinCode sessionRef={slug} mode={mode} onClose={() => setPairing(false)} /> : null}
    </div>
  )
}

function TaskDrawer({
  task,
  ownerName,
  onClose,
  onFilterChat,
}: {
  task: Task
  ownerName: string | null
  onClose: () => void
  onFilterChat: () => void
}) {
  return (
    <aside className="flex w-80 shrink-0 flex-col gap-5 overflow-y-auto border-l border-edge p-4 text-xs">
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-sm text-neutral-200">{task.title}</h2>
        <button className="text-mute hover:text-neutral-300" onClick={onClose}>
          ×
        </button>
      </div>

      <Row label="state" value={`${task.state}${ownerName ? ` · ${ownerName}` : ''}`} />
      <div>
        <p className="text-[10px] uppercase tracking-wider text-mute">Intent</p>
        <p className="mt-1 leading-relaxed text-neutral-300">{task.intent}</p>
      </div>

      <div>
        <p className="text-[10px] uppercase tracking-wider text-mute">Owns</p>
        <ul className="mt-1 space-y-0.5">
          {task.ownedPaths.map((path) => (
            <li key={path} className="break-all text-neutral-400">
              {path}
            </li>
          ))}
        </ul>
      </div>

      {task.assumes.length > 0 ? (
        <div>
          <p className="text-[10px] uppercase tracking-wider text-mute">Assumes from contract</p>
          <ul className="mt-1 space-y-0.5">
            {task.assumes.map((assumption) => (
              <li key={assumption} className="text-neutral-400">
                {assumption}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div>
        <p className="text-[10px] uppercase tracking-wider text-mute">Proven by</p>
        <code className="mt-1 block break-all text-accent">{task.acceptance.testCommand}</code>
        {task.lastTest ? (
          <p className={`mt-1 ${task.lastTest.passed ? 'text-accent' : 'text-red-400'}`}>
            {task.lastTest.passed ? 'passed' : 'failed'} · {task.lastTest.summary}
          </p>
        ) : null}
      </div>

      {task.dependsOn.length > 0 ? (
        <Row label="depends on" value={task.dependsOn.join(', ')} />
      ) : null}
      {task.branch ? <Row label="branch" value={task.branch} /> : null}

      <button className="btn" onClick={onFilterChat}>
        show chat for #{task.id}
      </button>
    </aside>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-mute">{label}</p>
      <p className="mt-1 break-all text-neutral-300">{value}</p>
    </div>
  )
}

function Gate() {
  const { me, mode, loading } = useAuth()
  const { value: slug, ready } = useQueryParam('s')
  const [peerSlug, setPeerSlug] = useState<string | null>(null)
  const [resolving, setResolving] = useState(false)

  /**
   * A returning peer visitor has a token but no session in the URL. Their token
   * is scoped to exactly one session, so the server can say which.
   */
  useEffect(() => {
    if (loading || !ready || mode !== 'peer' || peerSlug || slug) return
    if (!peerToken.get()) return

    setResolving(true)
    api
      .sessions()
      .then((result) => setPeerSlug(result.sessions[0]?.slug ?? null))
      .catch(() => peerToken.clear())
      .finally(() => setResolving(false))
  }, [loading, ready, mode, peerSlug, slug])

  if (loading || !ready || resolving) return <div className="p-6 text-xs text-mute">…</div>

  // A peer board is authorised by the token it holds, not by an account.
  if (mode === 'peer') {
    const seated = peerSlug ?? (peerToken.get() ? slug : null)
    if (!seated) return <PeerGate onSeated={(seat) => setPeerSlug(seat.sessionRef)} />
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
