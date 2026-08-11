import type { GraphLink, GraphNode } from './graph'

/**
 * A small velocity-Verlet force layout, hand-rolled rather than pulled in.
 * Sessions have tens of nodes, not thousands, so the naive O(n^2) repulsion is
 * far cheaper than the dependency would be -- and this way the tuning is
 * readable instead of buried behind someone else's defaults.
 */
export interface ForceOptions {
  repulsion: number
  linkDistance: Record<GraphLink['kind'], number>
  linkStrength: Record<GraphLink['kind'], number>
  centering: number
  damping: number
}

export const DEFAULT_FORCES: ForceOptions = {
  /**
   * Strong enough that labels under adjacent nodes do not collide. Node labels
   * are the whole point of this view, so the layout is tuned for readable text
   * rather than for a compact ball.
   */
  repulsion: 26000,
  // Membership links are short so topics visibly clump; dependencies are long
  // so the flow between clusters stays legible.
  linkDistance: { membership: 95, dependency: 210, assumption: 170 },
  linkStrength: { membership: 0.09, dependency: 0.03, assumption: 0.025 },
  centering: 0.004,
  damping: 0.85,
}

const MAX_VELOCITY = 30

export function stepSimulation(
  nodes: GraphNode[],
  links: GraphLink[],
  alpha: number,
  options: ForceOptions = DEFAULT_FORCES,
): void {
  const byId = new Map(nodes.map((node) => [node.id, node]))

  // Every node pushes every other away, so unrelated clusters drift apart.
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i]!
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j]!
      let dx = b.x - a.x
      let dy = b.y - a.y
      let distanceSquared = dx * dx + dy * dy

      // Perfectly coincident nodes would divide by zero; nudge them apart.
      if (distanceSquared < 0.01) {
        dx = (i % 2 === 0 ? 1 : -1) * 0.5
        dy = (j % 2 === 0 ? 1 : -1) * 0.5
        distanceSquared = dx * dx + dy * dy
      }

      const distance = Math.sqrt(distanceSquared)
      const force = (options.repulsion * alpha) / distanceSquared
      const fx = (dx / distance) * force
      const fy = (dy / distance) * force

      a.vx -= fx
      a.vy -= fy
      b.vx += fx
      b.vy += fy
    }
  }

  // Links pull their endpoints toward a rest length.
  for (const link of links) {
    const source = byId.get(link.source)
    const target = byId.get(link.target)
    if (!source || !target) continue

    const dx = target.x - source.x
    const dy = target.y - source.y
    const distance = Math.max(Math.sqrt(dx * dx + dy * dy), 0.01)
    const rest = options.linkDistance[link.kind]
    const strength = options.linkStrength[link.kind] * alpha
    const displacement = (distance - rest) * strength

    const fx = (dx / distance) * displacement
    const fy = (dy / distance) * displacement

    source.vx += fx
    source.vy += fy
    target.vx -= fx
    target.vy -= fy
  }

  for (const node of nodes) {
    if (node.fixed) {
      node.vx = 0
      node.vy = 0
      continue
    }

    // Gentle pull to the origin keeps the whole graph on screen.
    node.vx -= node.x * options.centering * alpha
    node.vy -= node.y * options.centering * alpha

    node.vx = clamp(node.vx * options.damping, MAX_VELOCITY)
    node.vy = clamp(node.vy * options.damping, MAX_VELOCITY)
    node.x += node.vx
    node.y += node.vy
  }
}

function clamp(value: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, value))
}

/** Radius grows with connectedness, the way it does in a knowledge graph. */
export function radiusOf(node: GraphNode): number {
  if (node.kind === 'topic') return 7 + Math.min(node.degree, 8) * 1.6
  if (node.kind === 'contract') return 8 + Math.min(node.degree, 8) * 1.2
  return 5.5 + Math.min(node.degree, 6) * 1.1
}
