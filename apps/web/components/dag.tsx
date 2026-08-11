'use client'

import type { Participant, Task } from '@session-share/protocol'

const COLUMN_WIDTH = 260
const NODE_HEIGHT = 92
const ROW_GAP = 20
const PADDING = 24

const STATE_RING: Record<string, string> = {
  blocked: 'border-edge text-mute',
  ready: 'border-accent/60 shadow-[0_0_0_1px_rgba(74,222,128,0.25)]',
  claimed: 'border-sky-400/60',
  running: 'border-sky-400',
  testing: 'border-amber-400',
  pr: 'border-violet-400',
  merged: 'border-emerald-500',
  failed: 'border-red-500',
}

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

interface Placed {
  task: Task
  x: number
  y: number
}

/**
 * Laid out left to right by dependency depth rather than as columns of status.
 * The shape of the graph is the point: what can start now, what is waiting on
 * whom, and where the critical path runs.
 */
export function Dag({
  tasks,
  participants,
  activity,
  selected,
  onSelect,
}: {
  tasks: Task[]
  participants: Participant[]
  activity: Record<string, string>
  selected: string | null
  onSelect: (taskId: string) => void
}) {
  const byDepth = new Map<number, Task[]>()
  for (const task of [...tasks].sort((a, b) => a.id.localeCompare(b.id))) {
    const column = byDepth.get(task.depth) ?? []
    column.push(task)
    byDepth.set(task.depth, column)
  }

  const placed = new Map<string, Placed>()
  for (const [depth, column] of byDepth) {
    column.forEach((task, index) => {
      placed.set(task.id, {
        task,
        x: PADDING + depth * COLUMN_WIDTH,
        y: PADDING + index * (NODE_HEIGHT + ROW_GAP),
      })
    })
  }

  const depths = [...byDepth.keys()]
  const width = PADDING * 2 + (Math.max(...depths, 0) + 1) * COLUMN_WIDTH
  const height =
    PADDING * 2 + Math.max(...[...byDepth.values()].map((c) => c.length), 1) * (NODE_HEIGHT + ROW_GAP)

  const edges: Array<{ from: Placed; to: Placed; satisfied: boolean }> = []
  for (const task of tasks) {
    const to = placed.get(task.id)
    if (!to) continue
    for (const dependency of task.dependsOn) {
      const from = placed.get(dependency)
      if (from) {
        edges.push({ from, to, satisfied: from.task.state === 'merged' })
      }
    }
  }

  if (tasks.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-xs leading-relaxed text-mute">
        No tasks yet.
        <br />
        Run <code className="mx-1 text-neutral-400">/ss:plan</code> in an attached checkout to split
        the work.
      </div>
    )
  }

  return (
    <div className="scroll-x h-full">
      <div className="relative" style={{ width, height, minWidth: '100%' }}>
        <svg className="absolute inset-0 pointer-events-none" width={width} height={height}>
          {edges.map(({ from, to, satisfied }, index) => {
            const x1 = from.x + COLUMN_WIDTH - 60
            const y1 = from.y + NODE_HEIGHT / 2
            const x2 = to.x
            const y2 = to.y + NODE_HEIGHT / 2
            const mid = (x1 + x2) / 2
            return (
              <path
                key={index}
                d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                fill="none"
                stroke={satisfied ? 'rgb(16 185 129 / 0.5)' : 'rgb(28 32 39)'}
                strokeWidth={1.5}
              />
            )
          })}
        </svg>

        {[...placed.values()].map(({ task, x, y }) => {
          const owner = participants.find((p) => p.id === task.ownerId)
          const line = activity[task.id]
          return (
            <button
              key={task.id}
              onClick={() => onSelect(task.id)}
              className={`absolute flex flex-col justify-between border bg-panel p-3 text-left transition-colors hover:bg-[#12151b] ${STATE_RING[task.state] ?? 'border-edge'} ${selected === task.id ? 'ring-1 ring-neutral-400' : ''}`}
              style={{ left: x, top: y, width: COLUMN_WIDTH - 60, height: NODE_HEIGHT }}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="truncate text-xs text-neutral-200">{task.title}</span>
                {owner ? (
                  <span
                    title={owner.displayName}
                    className={`mt-1 h-2 w-2 shrink-0 rounded-full ${DOT[owner.colorIndex % DOT.length]}`}
                  />
                ) : null}
              </div>

              <div className="space-y-1">
                <p className="truncate text-[10px] uppercase tracking-wider text-mute">
                  {task.state}
                  {task.lastTest ? (task.lastTest.passed ? ' · green' : ' · failing') : ''}
                </p>
                {line ? (
                  <p className="truncate text-[10px] text-sky-300/80">{line}</p>
                ) : (
                  <p className="truncate font-mono text-[10px] text-mute">{task.id}</p>
                )}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
