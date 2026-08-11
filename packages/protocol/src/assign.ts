import { analyzeDag } from './validate.js'
import type { ParticipantId, TaskId } from './ids.js'
import type { Assignment, TaskSpec } from './domain.js'

/**
 * Who should do what, decided by rule rather than by an LLM.
 *
 * The same reasoning as the validator: whether two people are about to collide,
 * and whether anyone is left with nothing to do, are questions with right
 * answers. A model guessing at them produces a plausible split where one person
 * owns everything on the critical path and the other waits.
 *
 * Three things are traded off, in order:
 *
 * 1. **Nobody idles at a given depth.** Tasks that can run at the same time go
 *    to different people. This is the whole point of splitting the work, so it
 *    beats everything else.
 * 2. **Even load**, measured in the planner's own minute estimates rather than
 *    task count -- four trivial tasks are not two hard ones.
 * 3. **Topic affinity.** Someone already holding `src/lib/**` should get the
 *    next `src/lib` task, because they have the context and because it keeps
 *    each person's diff inside one area of the tree.
 *
 * Deterministic: same tasks and same participants in, same assignment out. It
 * runs on every proposal, so a jittery result would move cards under people.
 */
export interface AssignmentInput {
  tasks: TaskSpec[]
  /** In a stable order -- joined-at, as the projection keeps them. */
  participants: ParticipantId[]
  /** Assignments a human already made, which are never overridden. */
  pinned?: Array<{ taskId: TaskId; participantId: ParticipantId }>
}

/** The first path segment, which is what "same area of the codebase" means here. */
function topicOf(spec: TaskSpec): string {
  const glob = spec.ownedPaths[0] ?? ''
  const meaningful = glob.split('/').find((segment) => segment && !segment.includes('*'))
  return meaningful ?? glob
}

export function autoAssign(input: AssignmentInput): Assignment[] {
  const people = input.participants
  if (people.length === 0 || input.tasks.length === 0) return []

  /**
   * A pin naming someone who is no longer here is dropped rather than honoured.
   * Keeping it would leave that task assigned to a ghost -- and skipping the
   * task instead would silently lose it from the split.
   */
  const known = new Set(people)
  const pinned = new Map(
    (input.pinned ?? []).filter((a) => known.has(a.participantId)).map((a) => [a.taskId, a.participantId]),
  )
  const { depthByTask } = analyzeDag(input.tasks)

  const load = new Map<ParticipantId, number>(people.map((id) => [id, 0]))
  const topics = new Map<ParticipantId, Set<string>>(people.map((id) => [id, new Set()]))
  const assigned: Assignment[] = []

  // Honour the human's choices first, so the balancing works around them
  // instead of against them.
  for (const spec of input.tasks) {
    const owner = pinned.get(spec.id)
    if (!owner || !load.has(owner)) continue
    load.set(owner, load.get(owner)! + spec.estimateMinutes)
    topics.get(owner)!.add(topicOf(spec))
    assigned.push({ taskId: spec.id, participantId: owner, manual: true })
  }

  /**
   * Depth first, then the long tasks. Placing the big items while the board is
   * still empty is what keeps the last few from all landing on one person.
   */
  const queue = input.tasks
    .filter((spec) => !pinned.has(spec.id))
    .sort(
      (a, b) =>
        (depthByTask.get(a.id) ?? 0) - (depthByTask.get(b.id) ?? 0) ||
        b.estimateMinutes - a.estimateMinutes ||
        a.id.localeCompare(b.id),
    )

  /** Who is already taken at this depth -- the rule that beats load balance. */
  const busyAtDepth = new Map<number, Set<ParticipantId>>()
  for (const { taskId, participantId } of assigned) {
    const depth = depthByTask.get(taskId) ?? 0
    if (!busyAtDepth.has(depth)) busyAtDepth.set(depth, new Set())
    busyAtDepth.get(depth)!.add(participantId)
  }

  for (const spec of queue) {
    const depth = depthByTask.get(spec.id) ?? 0
    const busy = busyAtDepth.get(depth) ?? new Set<ParticipantId>()
    const topic = topicOf(spec)

    // Everyone at this depth already has something: the frontier is narrower
    // than the team, so fall back to pure balance.
    const free = people.filter((id) => !busy.has(id))
    const candidates = free.length > 0 ? free : people

    const best = [...candidates].sort((a, b) => {
      const affinityA = topics.get(a)!.has(topic) ? 1 : 0
      const affinityB = topics.get(b)!.has(topic) ? 1 : 0
      return (
        load.get(a)! - load.get(b)! ||
        affinityB - affinityA ||
        people.indexOf(a) - people.indexOf(b)
      )
    })[0]!

    load.set(best, load.get(best)! + spec.estimateMinutes)
    topics.get(best)!.add(topic)
    if (!busyAtDepth.has(depth)) busyAtDepth.set(depth, new Set())
    busyAtDepth.get(depth)!.add(best)
    assigned.push({ taskId: spec.id, participantId: best, manual: false })
  }

  // Task order, not assignment order, so the board renders stably.
  const order = new Map(input.tasks.map((spec, index) => [spec.id, index]))
  return assigned.sort((a, b) => (order.get(a.taskId) ?? 0) - (order.get(b.taskId) ?? 0))
}

/** Minutes each person is holding, for the board's "who has what" rail. */
export function loadByParticipant(
  tasks: TaskSpec[],
  assignments: Array<{ taskId: TaskId; participantId: ParticipantId }>,
): Map<ParticipantId, number> {
  const estimates = new Map(tasks.map((spec) => [spec.id, spec.estimateMinutes]))
  const load = new Map<ParticipantId, number>()
  for (const { taskId, participantId } of assignments) {
    load.set(participantId, (load.get(participantId) ?? 0) + (estimates.get(taskId) ?? 0))
  }
  return load
}
