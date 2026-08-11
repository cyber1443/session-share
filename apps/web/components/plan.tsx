'use client'

import { useMemo, useState } from 'react'
import { loadByParticipant, type SessionSnapshot, type ValidationIssue } from '@session-share/protocol'

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

/**
 * Planning, on the board.
 *
 * The browser cannot read a repository or run a model, so it does not pretend
 * to: it takes the brief and hands it to a participant's Claude Code, which
 * answers with a split. What the board *is* good at is everything after that --
 * seeing the whole shape at once, moving cards between people, and agreeing.
 * That is the half that was previously only reachable by typing into someone
 * else's terminal.
 */
export function Plan({
  snapshot,
  meId,
  onRequest,
  onAssign,
  onApprove,
  onReject,
}: {
  snapshot: SessionSnapshot
  meId: string | null
  onRequest: (goal: string, plannerId: string | null) => Promise<void>
  onAssign: (taskId: string, participantId: string | null) => Promise<void>
  onApprove: () => Promise<void>
  onReject: (reason: string) => Promise<void>
}) {
  const decomposition = snapshot.decomposition
  const validation = snapshot.validation
  const [goal, setGoal] = useState(snapshot.session.goal ?? '')
  const [planner, setPlanner] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /** Only people with a checkout can be given work, or asked to plan. */
  const workers = snapshot.participants.filter((p) => p.repoPath)

  const assignedTo = useMemo(
    () => new Map((decomposition?.assignments ?? []).map((a) => [a.taskId, a])),
    [decomposition?.assignments],
  )

  const load = useMemo(
    () => loadByParticipant(decomposition?.tasks ?? [], decomposition?.assignments ?? []),
    [decomposition?.tasks, decomposition?.assignments],
  )

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'failed')
    } finally {
      setBusy(false)
    }
  }

  const errors = (validation?.issues ?? []).filter((issue) => issue.severity === 'error')
  const warnings = (validation?.issues ?? []).filter((issue) => issue.severity === 'warning')
  const proposed = decomposition?.status === 'proposed'
  const approvable = proposed && validation?.ok
  const alreadyApproved = Boolean(meId && decomposition?.approvals.includes(meId as never))

  return (
    <div className="mx-auto h-full w-full max-w-3xl overflow-y-auto px-6 py-8">
      {/* -- the brief ------------------------------------------------------ */}
      <section className="space-y-3">
        <h2 className="text-[10px] uppercase tracking-wider text-mute">What are we building</h2>
        <textarea
          className="field min-h-24 w-full resize-y leading-relaxed"
          placeholder="Add due dates to todos: a date on each item, a way to set it, and overdue ones marked in the list."
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
        />
        <div className="flex flex-wrap items-center gap-3">
          <select
            className="field w-auto"
            value={planner}
            onChange={(event) => setPlanner(event.target.value)}
          >
            <option value="">planner: session lead</option>
            {workers.map((participant) => (
              <option key={participant.id} value={participant.id}>
                planner: {participant.displayName}
              </option>
            ))}
          </select>
          <button
            className="btn btn-accent"
            disabled={!goal.trim() || busy || workers.length === 0}
            onClick={() => void run(() => onRequest(goal.trim(), planner || null))}
          >
            {decomposition ? 'plan it again' : 'plan it'}
          </button>
          <p className="text-[10px] leading-relaxed text-mute">
            {workers.length === 0
              ? 'Nobody has a checkout attached yet, so there is no repo to read. Run /ss:host or /ss:join in a clone.'
              : 'Their Claude Code reads the repo and answers with a split, which appears here. It picks the request up when its current turn ends.'}
          </p>
        </div>
        {error ? <p className="text-xs text-red-400">{error}</p> : null}
      </section>

      {!decomposition ? (
        <p className="mt-10 text-xs leading-relaxed text-mute">
          Nothing proposed yet. A split is a contract — the shared types and stubs every task
          imports — plus tasks that own disjoint files and are each proved by one command.
        </p>
      ) : null}

      {/* -- what came back ------------------------------------------------- */}
      {decomposition ? (
        <section className="mt-10 space-y-4">
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="text-[10px] uppercase tracking-wider text-mute">
              Proposed split · {decomposition.tasks.length} tasks
            </h2>
            <span className="text-[10px] text-mute">
              up to {validation?.maxFrontier ?? 0} at once
            </span>
          </div>

          {errors.length > 0 ? (
            <div className="panel space-y-2 border-red-500/30 p-3">
              <p className="text-[10px] uppercase tracking-wider text-red-400">
                {errors.length} blocking problem(s) — cannot be approved
              </p>
              {errors.map((issue, index) => (
                <Issue key={index} issue={issue} />
              ))}
              <p className="text-[10px] leading-relaxed text-mute">
                Edit the brief above with what to fix and press <em>plan it again</em>.
              </p>
            </div>
          ) : null}

          {warnings.map((issue, index) => (
            <div key={index} className="panel border-amber-500/20 p-3">
              <Issue issue={issue} />
            </div>
          ))}

          <div className="panel p-3">
            <p className="text-[10px] uppercase tracking-wider text-mute">The seam</p>
            <p className="mt-1 text-xs leading-relaxed text-neutral-300">
              {decomposition.contract.summary}
            </p>
            <ul className="mt-2 space-y-0.5">
              {decomposition.contract.files.map((file) => (
                <li key={file.path} className="text-[10px] text-mute">
                  <code className="text-accent">{file.path}</code> — {file.purpose}
                </li>
              ))}
            </ul>
          </div>

          {/* -- assignment --------------------------------------------------- */}
          <ul className="space-y-2">
            {decomposition.tasks.map((task) => {
              const assignment = assignedTo.get(task.id)
              const owner = snapshot.participants.find((p) => p.id === assignment?.participantId)
              return (
                <li key={task.id} className="panel flex items-start gap-3 p-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <code className="text-accent">{task.id}</code>
                      <span className="truncate text-xs text-neutral-200">{task.title}</span>
                      <span className="shrink-0 text-[10px] text-mute">{task.estimateMinutes}m</span>
                    </div>
                    <p className="mt-1 text-[10px] leading-relaxed text-mute">{task.intent}</p>
                    <p className="mt-1 break-all text-[10px] text-mute">
                      owns {task.ownedPaths.join(' · ')}
                      {task.dependsOn.length > 0 ? ` · after ${task.dependsOn.join(', ')}` : ''}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    {owner ? (
                      <span
                        className={`h-2 w-2 rounded-full ${DOT[owner.colorIndex % DOT.length]}`}
                      />
                    ) : null}
                    <select
                      className="field w-auto text-[10px]"
                      value={assignment?.participantId ?? ''}
                      disabled={busy || !proposed}
                      onChange={(event) =>
                        void run(() => onAssign(task.id, event.target.value || null))
                      }
                    >
                      <option value="">nobody</option>
                      {workers.map((participant) => (
                        <option key={participant.id} value={participant.id}>
                          {participant.displayName}
                        </option>
                      ))}
                    </select>
                    {assignment?.manual ? (
                      <span className="text-[10px] text-accent" title="set by hand; kept when the rest rebalances">
                        pinned
                      </span>
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ul>

          {/* -- who ends up with what ---------------------------------------- */}
          <div className="flex flex-wrap gap-4 text-[10px] text-mute">
            {workers.map((participant) => (
              <span key={participant.id}>
                <span
                  className={`mr-1 inline-block h-2 w-2 rounded-full align-middle ${DOT[participant.colorIndex % DOT.length]}`}
                />
                {participant.displayName}: {load.get(participant.id as never) ?? 0}m
              </span>
            ))}
          </div>

          {/* -- agreeing ------------------------------------------------------ */}
          {proposed ? (
            <div className="flex items-center gap-3 border-t border-edge pt-4">
              <button
                className="btn btn-accent"
                disabled={!approvable || busy || alreadyApproved || !meId}
                onClick={() => void run(onApprove)}
              >
                {alreadyApproved ? 'approved — waiting for the others' : 'approve the split'}
              </button>
              <button
                className="btn"
                disabled={busy || !meId}
                onClick={() => void run(() => onReject('rejected on the board'))}
              >
                reject
              </button>
              <span className="text-[10px] text-mute">
                {decomposition.approvals.length} of {workers.length} approved
                {!meId ? ' · your seat is not identified, reload the board' : ''}
              </span>
            </div>
          ) : (
            <p className="text-xs text-accent">
              {decomposition.status === 'approved'
                ? 'Approved. Land the contract with /ss:land, then everyone runs /ss:next.'
                : 'Rejected. Edit the brief and plan it again.'}
            </p>
          )}
        </section>
      ) : null}
    </div>
  )
}

function Issue({ issue }: { issue: ValidationIssue }) {
  return (
    <div className="text-[10px] leading-relaxed">
      <p className="text-neutral-300">{issue.message}</p>
      <p className="text-mute">{issue.repairHint}</p>
    </div>
  )
}
