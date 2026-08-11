import type { Contract, Task } from '@session-share/protocol'

export type NodeKind = 'topic' | 'task' | 'contract'

export interface GraphNode {
  id: string
  kind: NodeKind
  label: string
  /** Topic this node belongs to; drives colour. Topics are their own topic. */
  topic: string
  task: Task | null
  /** Link count, which sets the radius the way a knowledge graph does. */
  degree: number
  x: number
  y: number
  vx: number
  vy: number
  fixed: boolean
}

export type LinkKind = 'membership' | 'dependency' | 'assumption'

export interface GraphLink {
  source: string
  target: string
  kind: LinkKind
}

export interface Graph {
  nodes: GraphNode[]
  links: GraphLink[]
  topics: string[]
}

/**
 * A task's topic is the deepest directory its owned paths agree on. Tasks are
 * cut as vertical slices, so their paths already cluster by feature area --
 * which means the folder structure is a usable proxy for "what is this about"
 * without anyone having to label anything.
 */
export function topicOf(task: Task): string {
  const directories = task.ownedPaths.map(directoryOf)
  const first = directories[0]
  if (!first) return 'misc'

  let common = first
  for (const directory of directories.slice(1)) {
    common = commonPrefix(common, directory)
  }

  /**
   * The FIRST meaningful segment, not the last. A task owning
   * `src/components/theme-toggle/**` belongs to "components" alongside its
   * siblings -- taking the last segment would give every task a topic of one,
   * which is a legend, not a clustering.
   */
  const segments = common[0] === 'src' ? common.slice(1) : common
  return segments[0] ?? common[0] ?? 'misc'
}

function directoryOf(glob: string): string[] {
  const segments = glob.split('/').filter(Boolean)
  const stop = segments.findIndex((segment) => segment.includes('*') || segment.includes('.'))
  return stop === -1 ? segments : segments.slice(0, stop)
}

function commonPrefix(a: string[], b: string[]): string[] {
  const shared: string[] = []
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) break
    shared.push(a[i]!)
  }
  return shared
}

/** Deterministic starting positions; a seeded layout settles the same way twice. */
function seedPosition(index: number, total: number, radius: number) {
  const angle = (index / Math.max(total, 1)) * Math.PI * 2
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }
}

/**
 * Builds the knowledge-graph view: contract files in the middle as the seam
 * everything was planned against, tasks around them, and a hub per topic
 * pulling its own tasks together.
 */
export function buildGraph(tasks: Task[], contract: Contract | null): Graph {
  const nodes: GraphNode[] = []
  const links: GraphLink[] = []
  const topics = new Set<string>()

  const taskTopics = new Map<string, string>()
  for (const task of tasks) {
    const topic = topicOf(task)
    taskTopics.set(task.id, topic)
    topics.add(topic)
  }

  const topicList = [...topics].sort()
  topicList.forEach((topic, index) => {
    const { x, y } = seedPosition(index, topicList.length, 220)
    nodes.push({
      id: `topic:${topic}`,
      kind: 'topic',
      label: topic,
      topic,
      task: null,
      degree: 0,
      x,
      y,
      vx: 0,
      vy: 0,
      fixed: false,
    })
  })

  tasks.forEach((task, index) => {
    const topic = taskTopics.get(task.id)!
    const { x, y } = seedPosition(index, tasks.length, 340)
    nodes.push({
      id: `task:${task.id}`,
      kind: 'task',
      label: task.title,
      topic,
      task,
      degree: 0,
      x,
      y,
      vx: 0,
      vy: 0,
      fixed: false,
    })
    links.push({ source: `task:${task.id}`, target: `topic:${topic}`, kind: 'membership' })

    for (const dependency of task.dependsOn) {
      if (tasks.some((t) => t.id === dependency)) {
        links.push({ source: `task:${dependency}`, target: `task:${task.id}`, kind: 'dependency' })
      }
    }
  })

  const contractFiles = contract?.files ?? []
  contractFiles.forEach((file, index) => {
    const { x, y } = seedPosition(index, contractFiles.length, 60)
    nodes.push({
      id: `contract:${file.path}`,
      kind: 'contract',
      label: file.path.split('/').pop() ?? file.path,
      topic: 'contract',
      task: null,
      degree: 0,
      x,
      y,
      vx: 0,
      vy: 0,
      fixed: false,
    })

    // A task assumes a contract file when it names it, which is exactly the
    // dependency the seam exists to make explicit.
    for (const task of tasks) {
      const mentioned = task.assumes.some((assumption) => assumption.includes(file.path))
      if (mentioned) {
        links.push({
          source: `contract:${file.path}`,
          target: `task:${task.id}`,
          kind: 'assumption',
        })
      }
    }
  })

  const byId = new Map(nodes.map((node) => [node.id, node]))
  for (const link of links) {
    const source = byId.get(link.source)
    const target = byId.get(link.target)
    if (source) source.degree++
    if (target) target.degree++
  }

  return { nodes, links, topics: topicList }
}

/** Every node reachable in one hop, for the hover-highlight. */
export function neighboursOf(links: GraphLink[], id: string): Set<string> {
  const neighbours = new Set<string>([id])
  for (const link of links) {
    if (link.source === id) neighbours.add(link.target)
    if (link.target === id) neighbours.add(link.source)
  }
  return neighbours
}
