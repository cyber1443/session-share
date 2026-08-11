'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Contract, Participant, Task } from '@session-share/protocol'
import { DEFAULT_FORCES, radiusOf, stepSimulation } from '@/lib/force'
import { buildGraph, neighboursOf, type GraphNode } from '@/lib/graph'

/** Stable per-topic colour, so a cluster keeps its identity across reloads. */
const TOPIC_COLORS = [
  '#4ade80',
  '#38bdf8',
  '#fbbf24',
  '#a78bfa',
  '#fb7185',
  '#2dd4bf',
  '#fb923c',
  '#818cf8',
]

const STATE_COLORS: Record<string, string> = {
  blocked: '#3f3f46',
  ready: '#4ade80',
  claimed: '#38bdf8',
  running: '#38bdf8',
  testing: '#fbbf24',
  pr: '#a78bfa',
  merged: '#10b981',
  failed: '#ef4444',
}

const ALPHA_START = 1
const ALPHA_DECAY = 0.985
const ALPHA_MIN = 0.02

export function Graph({
  tasks,
  contract,
  participants,
  activity,
  selected,
  onSelect,
}: {
  tasks: Task[]
  contract: Contract | null
  participants: Participant[]
  activity: Record<string, string>
  selected: string | null
  onSelect: (taskId: string) => void
}) {
  const container = useRef<HTMLDivElement>(null)
  const frame = useRef<number | null>(null)
  const alpha = useRef(ALPHA_START)
  const dragging = useRef<string | null>(null)
  const panning = useRef<{ x: number; y: number } | null>(null)
  /** Distinguishes a click on empty space from the end of a pan. */
  const moved = useRef(false)

  const [, forceRender] = useState(0)
  const [hovered, setHovered] = useState<string | null>(null)
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 })
  const [size, setSize] = useState({ width: 900, height: 600 })

  /**
   * The graph is rebuilt only when the shape changes -- not on every task state
   * change -- so a task turning green does not throw the layout away and
   * re-settle it under the user's cursor.
   */
  const shapeKey = useMemo(
    () =>
      JSON.stringify([
        tasks.map((t) => [t.id, t.ownedPaths, t.dependsOn, t.assumes]),
        contract?.files.map((f) => f.path) ?? [],
      ]),
    [tasks, contract],
  )

  const graph = useMemo(() => buildGraph(tasks, contract), [shapeKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const taskById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks])
  const colorOfTopic = useCallback(
    (topic: string) =>
      topic === 'contract'
        ? '#e5e7eb'
        : TOPIC_COLORS[graph.topics.indexOf(topic) % TOPIC_COLORS.length]!,
    [graph.topics],
  )

  useEffect(() => {
    const element = container.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // Run the layout until it settles, then stop burning frames.
  useEffect(() => {
    alpha.current = ALPHA_START
    const tick = () => {
      stepSimulation(graph.nodes, graph.links, alpha.current, DEFAULT_FORCES)
      alpha.current *= ALPHA_DECAY
      forceRender((n) => n + 1)
      frame.current = alpha.current > ALPHA_MIN || dragging.current ? requestAnimationFrame(tick) : null
    }
    frame.current = requestAnimationFrame(tick)
    return () => {
      if (frame.current) cancelAnimationFrame(frame.current)
      frame.current = null
    }
  }, [graph])

  const reheat = useCallback(() => {
    alpha.current = Math.max(alpha.current, 0.35)
    if (frame.current === null) {
      const tick = () => {
        stepSimulation(graph.nodes, graph.links, alpha.current, DEFAULT_FORCES)
        alpha.current *= ALPHA_DECAY
        forceRender((n) => n + 1)
        frame.current =
          alpha.current > ALPHA_MIN || dragging.current ? requestAnimationFrame(tick) : null
      }
      frame.current = requestAnimationFrame(tick)
    }
  }, [graph])

  const toWorld = useCallback(
    (clientX: number, clientY: number) => {
      const rect = container.current?.getBoundingClientRect()
      if (!rect) return { x: 0, y: 0 }
      return {
        x: (clientX - rect.left - size.width / 2 - view.x) / view.scale,
        y: (clientY - rect.top - size.height / 2 - view.y) / view.scale,
      }
    },
    [size, view],
  )

  const onPointerDown = (event: React.PointerEvent, node?: GraphNode) => {
    ;(event.target as Element).setPointerCapture?.(event.pointerId)
    moved.current = false
    if (node) {
      dragging.current = node.id
      node.fixed = true
      reheat()
    } else {
      panning.current = { x: event.clientX - view.x, y: event.clientY - view.y }
    }
  }

  const onPointerMove = (event: React.PointerEvent) => {
    if (dragging.current || panning.current) moved.current = true
    if (dragging.current) {
      const node = graph.nodes.find((n) => n.id === dragging.current)
      if (node) {
        const world = toWorld(event.clientX, event.clientY)
        node.x = world.x
        node.y = world.y
        forceRender((n) => n + 1)
      }
      return
    }
    if (panning.current) {
      setView((current) => ({
        ...current,
        x: event.clientX - panning.current!.x,
        y: event.clientY - panning.current!.y,
      }))
    }
  }

  const onPointerUp = () => {
    if (dragging.current) {
      const node = graph.nodes.find((n) => n.id === dragging.current)
      // Released nodes rejoin the simulation rather than staying pinned.
      if (node) node.fixed = false
      dragging.current = null
      reheat()
    }
    panning.current = null
  }

  const onWheel = (event: React.WheelEvent) => {
    const next = Math.min(2.5, Math.max(0.35, view.scale * (event.deltaY > 0 ? 0.92 : 1.08)))
    setView((current) => ({ ...current, scale: next }))
  }

  const highlighted = useMemo(() => {
    const focus = hovered ?? (selected ? `task:${selected}` : null)
    return focus ? neighboursOf(graph.links, focus) : null
  }, [hovered, selected, graph.links])

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
    <div
      ref={container}
      className="relative h-full w-full cursor-grab overflow-hidden active:cursor-grabbing"
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
      onPointerDown={(event) => onPointerDown(event)}
      onClick={() => {
        if (!moved.current && selected) onSelect(selected)
      }}
      onWheel={onWheel}
    >
      <svg width={size.width} height={size.height} className="block">
        <g transform={`translate(${size.width / 2 + view.x} ${size.height / 2 + view.y}) scale(${view.scale})`}>
          {graph.links.map((link, index) => {
            const source = graph.nodes.find((n) => n.id === link.source)
            const target = graph.nodes.find((n) => n.id === link.target)
            if (!source || !target) return null
            const dim = highlighted && !(highlighted.has(source.id) && highlighted.has(target.id))
            return (
              <line
                key={index}
                x1={source.x}
                y1={source.y}
                x2={target.x}
                y2={target.y}
                stroke={link.kind === 'dependency' ? '#4b5563' : '#262b33'}
                strokeWidth={link.kind === 'dependency' ? 1.4 : 1}
                strokeDasharray={link.kind === 'assumption' ? '3 3' : undefined}
                opacity={dim ? 0.12 : 1}
              />
            )
          })}

          {graph.nodes.map((node) => {
            const radius = radiusOf(node)
            const dim = highlighted && !highlighted.has(node.id)
            const topicColor = colorOfTopic(node.topic)
            const live = node.task ? activity[node.task.id] : null

            const fill =
              node.kind === 'task'
                ? (STATE_COLORS[node.task!.state] ?? topicColor)
                : node.kind === 'contract'
                  ? '#0e1014'
                  : topicColor

            const owner = node.task
              ? participants.find((p) => p.id === (node.task!.ownerId ?? node.task!.assigneeId))
              : undefined

            return (
              <g
                key={node.id}
                opacity={dim ? 0.18 : 1}
                onPointerDown={(event) => {
                  event.stopPropagation()
                  onPointerDown(event, node)
                }}
                onPointerEnter={() => setHovered(node.id)}
                onPointerLeave={() => setHovered(null)}
                onClick={(event) => {
                  event.stopPropagation()
                  if (node.task) onSelect(node.task.id)
                }}
                className={node.kind === 'task' ? 'cursor-pointer' : 'cursor-grab'}
              >
                <circle
                  cx={node.x}
                  cy={node.y}
                  r={radius}
                  fill={fill}
                  /**
                   * Fill carries state, ring carries topic. Both matter and
                   * neither should require reading a label to recover.
                   */
                  stroke={
                    selected && node.task?.id === selected
                      ? '#f4f4f5'
                      : node.kind === 'contract'
                        ? '#e5e7eb'
                        : topicColor
                  }
                  strokeWidth={
                    selected && node.task?.id === selected ? 3 : node.kind === 'task' ? 2.5 : 1.5
                  }
                  strokeDasharray={node.kind === 'contract' ? '2 2' : undefined}
                />

                {owner ? (
                  <circle
                    cx={node.x + radius * 0.85}
                    cy={node.y - radius * 0.85}
                    r={3}
                    fill={TOPIC_COLORS[owner.colorIndex % TOPIC_COLORS.length]}
                    stroke="#07080a"
                    strokeWidth={1}
                  />
                ) : null}

                <text
                  x={node.x}
                  y={node.y + radius + 11}
                  textAnchor="middle"
                  className="pointer-events-none select-none"
                  fontSize={node.kind === 'topic' ? 11 : 9.5}
                  fill={node.kind === 'topic' ? topicColor : '#a1a1aa'}
                >
                  {truncate(node.label, node.kind === 'topic' ? 18 : 22)}
                </text>

                {live ? (
                  <text
                    x={node.x}
                    y={node.y + radius + 22}
                    textAnchor="middle"
                    className="pointer-events-none select-none"
                    fontSize={8.5}
                    fill="#7dd3fc"
                  >
                    {truncate(live, 30)}
                  </text>
                ) : null}
              </g>
            )
          })}
        </g>
      </svg>

      <Legend topics={graph.topics} colorOf={colorOfTopic} hasContract={Boolean(contract)} />

      <div className="pointer-events-none absolute bottom-3 right-3 text-[10px] text-mute">
        drag nodes · scroll to zoom · drag background to pan
      </div>
    </div>
  )
}

function Legend({
  topics,
  colorOf,
  hasContract,
}: {
  topics: string[]
  colorOf: (topic: string) => string
  hasContract: boolean
}) {
  return (
    <div className="pointer-events-none absolute left-3 top-3 space-y-1 text-[10px]">
      {topics.map((topic) => (
        <div key={topic} className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full" style={{ background: colorOf(topic) }} />
          <span className="text-mute">{topic}</span>
        </div>
      ))}
      {hasContract ? (
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full border border-dashed border-neutral-300" />
          <span className="text-mute">contract</span>
        </div>
      ) : null}
      <p className="pt-1 text-mute/70">ring = topic · fill = state</p>
    </div>
  )
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}
