'use client'

import type { Participant, SessionSnapshot, Ticket } from '@session-share/protocol'

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

const STATE_COLOUR: Record<string, string> = {
  blocked: 'text-mute/60',
  ready: 'text-neutral-300',
  claimed: 'text-sky-400',
  running: 'text-sky-400',
  testing: 'text-amber-400',
  failed: 'text-red-400',
  pr: 'text-violet-400',
  merged: 'text-accent',
}

/**
 * Everything about one ticket, in the place you were already looking.
 *
 * The board answers "where is this"; opening a card has to answer "what is
 * actually happening" -- the split that was proposed, who has which task, what
 * their agent is doing right now, and what is stopping it. Anything that made
 * you go and ask a person is a gap here.
 */
export function TicketPanel({
  ticket,
  snapshot,
  meId,
  activity,
  onClose,
  onJoin,
  onLeave,
  onStart,
  onApprove,
  onAssign,
}: {
  ticket: Ticket
  snapshot: SessionSnapshot
  meId: string | null
  activity: Record<string, string>
  onClose: () => void
  onJoin: () => Promise<void>
  onLeave: () => Promise<void>
  onStart: () => Promise<void>
  onApprove: () => Promise<void>
  onAssign: (taskId: string, participantId: string | null) => Promise<void>
}) {
  const tasks = snapshot.tasks.filter((task) => task.ticketId === ticket.id)
  const decomposition =
    snapshot.decomposition?.id === ticket.decompositionId ? snapshot.decomposition : null
  const proposed = tasks.length === 0 ? (decomposition?.tasks ?? []) : []
  const assignedTo = new Map((decomposition?.assignments ?? []).map((a) => [a.taskId, a]))

  const members = ticket.members
    .map((id) => snapshot.participants.find((p) => p.id === id))
    .filter((p): p is Participant => Boolean(p))
  const workers = members.filter((p) => p.repoPath)
  const mine = Boolean(meId && ticket.members.includes(meId as never))
  const merged = tasks.filter((task) => task.state === 'merged').length

  return (
    <aside className="flex w-96 shrink-0 flex-col gap-5 overflow-y-auto border-l border-edge p-4 text-xs">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm leading-snug text-neutral-200">{ticket.title}</h2>
          <p className="mt-1 text-[10px] uppercase tracking-wider text-mute">
            {ticket.state}
            {ticket.prNumber ? ` · PR #${ticket.prNumber}` : ''}
          </p>
        </div>
        <button className="text-mute hover:text-neutral-300" onClick={onClose}>
          ×
        </button>
      </div>

      {ticket.body ? <p className="leading-relaxed text-neutral-400">{ticket.body}</p> : null}

      {/* -- who ------------------------------------------------------------ */}
      <div>
        <p className="text-[10px] uppercase tracking-wider text-mute">In it</p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {members.length === 0 ? <span className="text-mute">nobody yet</span> : null}
          {members.map((member) => (
            <span key={member.id} className="flex items-center gap-1 text-neutral-300">
              <span className={`h-2 w-2 rounded-full ${DOT[member.colorIndex % DOT.length]}`} />
              {member.displayName}
              {member.repoPath ? '' : ' (watching)'}
            </span>
          ))}
          <span className="ml-auto flex gap-2">
            {mine ? (
              ticket.state === 'plan' ? (
                <button className="btn" onClick={() => void onLeave()}>
                  leave
                </button>
              ) : null
            ) : (
              <button className="btn btn-accent" disabled={!meId} onClick={() => void onJoin()}>
                join
              </button>
            )}
          </span>
        </div>
      </div>

      {/* -- what happens next ---------------------------------------------- */}
      {ticket.state === 'plan' ? (
        <div className="panel space-y-2 p-3">
          <p className="leading-relaxed text-neutral-300">
            Waiting for someone to join. Joining starts the split.
          </p>
          {mine ? (
            <button className="btn w-full" onClick={() => void onStart()}>
              split it now
            </button>
          ) : null}
        </div>
      ) : null}

      {ticket.state === 'splitting' ? (
        <div className="panel space-y-1 p-3">
          <p className="text-[10px] uppercase tracking-wider text-amber-400">Being split</p>
          <p className="leading-relaxed text-mute">
            {workers[0]?.displayName ?? 'An agent'} is reading the repository. It picks this up when
            their Claude Code next finishes a turn — if their terminal is idle, it starts as soon as
            they touch it.
          </p>
        </div>
      ) : null}

      {/* -- the split, before it runs --------------------------------------- */}
      {proposed.length > 0 ? (
        <div className="space-y-2">
          <div className="flex items-baseline justify-between">
            <p className="text-[10px] uppercase tracking-wider text-mute">
              Proposed split · {proposed.length} tasks
            </p>
            <span className="text-[10px] text-mute">
              {decomposition?.tasks.reduce((sum, t) => sum + t.estimateMinutes, 0)}m total
            </span>
          </div>

          {decomposition ? (
            <div className="panel p-2">
              <p className="text-[10px] uppercase tracking-wider text-mute">The seam</p>
              <p className="mt-1 leading-relaxed text-neutral-400">
                {decomposition.contract.summary}
              </p>
              {decomposition.contract.files.map((file) => (
                <p key={file.path} className="mt-0.5 break-all text-[10px] text-accent">
                  {file.path}
                </p>
              ))}
            </div>
          ) : null}

          <ul className="space-y-2">
            {proposed.map((task) => (
              <li key={task.id} className="panel p-2">
                <div className="flex items-baseline gap-2">
                  <code className="text-accent">{task.id}</code>
                  <span className="truncate text-neutral-300">{task.title}</span>
                  <span className="ml-auto shrink-0 text-[10px] text-mute">
                    {task.estimateMinutes}m
                  </span>
                </div>
                <p className="mt-1 break-all text-[10px] text-mute">{task.ownedPaths.join(' · ')}</p>
                <div className="mt-1 flex items-center gap-2">
                  <select
                    className="field w-auto text-[10px]"
                    value={assignedTo.get(task.id)?.participantId ?? ''}
                    onChange={(event) => void onAssign(task.id, event.target.value || null)}
                  >
                    <option value="">nobody</option>
                    {workers.map((worker) => (
                      <option key={worker.id} value={worker.id}>
                        {worker.displayName}
                      </option>
                    ))}
                  </select>
                  {assignedTo.get(task.id)?.manual ? (
                    <span className="text-[10px] text-accent">pinned</span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>

          <button
            className="btn btn-accent w-full"
            disabled={!mine}
            onClick={() => void onApprove()}
            title={mine ? '' : 'Join the ticket first'}
          >
            {mine ? 'start the work' : 'join to start it'}
          </button>
          <p className="text-[10px] leading-relaxed text-mute">
            Starting it hands each person their tasks and tells their agent to get on with them.
            Change who does what above first if you want to.
          </p>
        </div>
      ) : null}

      {/* -- the work, once it is running ------------------------------------ */}
      {tasks.length > 0 ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <p className="text-[10px] uppercase tracking-wider text-mute">
              {merged}/{tasks.length} landed
            </p>
            <span className="h-1 flex-1 overflow-hidden rounded bg-neutral-800">
              <span
                className="block h-full bg-accent transition-all"
                style={{ width: `${(merged / tasks.length) * 100}%` }}
              />
            </span>
          </div>

          <ul className="space-y-2">
            {tasks.map((task) => {
              const owner = snapshot.participants.find(
                (p) => p.id === (task.ownerId ?? task.assigneeId),
              )
              const line = activity[task.id]
              return (
                <li key={task.id} className="panel p-2">
                  <div className="flex items-baseline gap-2">
                    <code className="text-accent">{task.id}</code>
                    <span className={`ml-auto shrink-0 ${STATE_COLOUR[task.state] ?? 'text-mute'}`}>
                      {task.state}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-neutral-300">{task.title}</p>

                  <div className="mt-1 flex items-center gap-2 text-[10px]">
                    {owner ? (
                      <span className={`h-2 w-2 rounded-full ${DOT[owner.colorIndex % DOT.length]}`} />
                    ) : null}
                    {task.ownerId ? (
                      <span className="text-mute">{owner?.displayName} is on it</span>
                    ) : (
                      <select
                        className="field w-auto text-[10px]"
                        value={task.assigneeId ?? ''}
                        disabled={task.state === 'merged'}
                        onChange={(event) => void onAssign(task.id, event.target.value || null)}
                      >
                        <option value="">nobody</option>
                        {workers.map((worker) => (
                          <option key={worker.id} value={worker.id}>
                            {worker.displayName}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>

                  {/* What the agent is doing right now, if it is saying. */}
                  {line ? <p className="mt-1 truncate text-[10px] text-sky-400/70">{line}</p> : null}
                  {task.lastTest ? (
                    <p
                      className={`mt-1 text-[10px] ${task.lastTest.passed ? 'text-accent' : 'text-red-400'}`}
                    >
                      {task.lastTest.passed ? 'passed' : 'failed'} · {task.lastTest.summary}
                    </p>
                  ) : null}
                  {task.dependsOn.length > 0 && task.state === 'blocked' ? (
                    <p className="mt-1 text-[10px] text-mute">waiting on {task.dependsOn.join(', ')}</p>
                  ) : null}
                  {task.branch ? (
                    <p className="mt-1 break-all text-[10px] text-mute">{task.branch}</p>
                  ) : null}
                </li>
              )
            })}
          </ul>
        </div>
      ) : null}
    </aside>
  )
}
