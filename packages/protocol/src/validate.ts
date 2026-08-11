import type { Contract, TaskSpec, ValidationIssue, ValidationReport } from './domain.js'
import type { TaskId } from './ids.js'
import { globSetsIntersect, normalizeGlob, pathMatchesAny } from './glob.js'

/** Beyond this a task stops being one sitting; the planner should split it. */
const MAX_TASK_MINUTES = 90

export interface DagAnalysis {
  /** Longest path from a root; drives board layout and the ready frontier. */
  depthByTask: Map<string, number>
  /** Every task reachable through dependsOn, transitively. */
  ancestors: Map<string, Set<string>>
  cycle: string[] | null
  unknownDeps: Array<{ taskId: string; missing: string }>
}

export function analyzeDag(tasks: TaskSpec[]): DagAnalysis {
  const byId = new Map(tasks.map((t) => [t.id as string, t]))
  const unknownDeps: Array<{ taskId: string; missing: string }> = []
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!byId.has(dep as string)) unknownDeps.push({ taskId: task.id, missing: dep })
    }
  }

  const state = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []
  const depthByTask = new Map<string, number>()
  const ancestors = new Map<string, Set<string>>()
  let cycle: string[] | null = null

  const visit = (id: string): number => {
    const known = depthByTask.get(id)
    if (known !== undefined) return known
    if (state.get(id) === 'visiting') {
      if (!cycle) cycle = [...stack.slice(stack.indexOf(id)), id]
      return 0
    }

    state.set(id, 'visiting')
    stack.push(id)

    const task = byId.get(id)
    const inherited = new Set<string>()
    let depth = 0
    for (const dep of task?.dependsOn ?? []) {
      if (!byId.has(dep as string)) continue
      depth = Math.max(depth, visit(dep as string) + 1)
      inherited.add(dep as string)
      for (const grand of ancestors.get(dep as string) ?? []) inherited.add(grand)
    }

    stack.pop()
    state.set(id, 'done')
    depthByTask.set(id, depth)
    ancestors.set(id, inherited)
    return depth
  }

  for (const task of tasks) visit(task.id as string)
  return { depthByTask, ancestors, cycle, unknownDeps }
}

/** Two tasks run at the same time unless one transitively depends on the other. */
function canRunConcurrently(a: TaskSpec, b: TaskSpec, analysis: DagAnalysis): boolean {
  const aId = a.id as string
  const bId = b.id as string
  return !analysis.ancestors.get(aId)?.has(bId) && !analysis.ancestors.get(bId)?.has(aId)
}

/**
 * The gate between a planner's proposal and humans being asked to approve it.
 * Deterministic on purpose: an LLM must never be the thing deciding whether two
 * agents are about to collide.
 */
export function validateDecomposition(input: {
  contract: Contract
  tasks: TaskSpec[]
  participantCount: number
}): ValidationReport {
  const { contract, tasks, participantCount } = input
  const issues: ValidationIssue[] = []
  const analysis = analyzeDag(tasks)

  for (const { taskId, missing } of analysis.unknownDeps) {
    issues.push({
      code: 'unknown_dependency',
      severity: 'error',
      message: `Task "${taskId}" depends on "${missing}", which is not in the decomposition.`,
      taskIds: [taskId as TaskId],
      repairHint: `Either add a task with id "${missing}" or remove it from ${taskId}.dependsOn.`,
    })
  }

  if (analysis.cycle) {
    const cycle = analysis.cycle as string[]
    issues.push({
      code: 'dependency_cycle',
      severity: 'error',
      message: `Dependency cycle: ${cycle.join(' -> ')}.`,
      taskIds: cycle as TaskId[],
      repairHint:
        'Break the cycle by hoisting whatever the tasks mutually need into the contract, so both can depend on the contract instead of each other.',
    })
  }

  // -- the core rule: no two concurrently-ready tasks may own the same path ---
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i]!
      const b = tasks[j]!
      const overlap = globSetsIntersect(a.ownedPaths, b.ownedPaths)
      if (!overlap) continue

      const concurrent = canRunConcurrently(a, b, analysis)
      issues.push({
        code: 'overlapping_paths',
        severity: concurrent ? 'error' : 'warning',
        message: concurrent
          ? `Tasks "${a.id}" and "${b.id}" can run at the same time and both own "${overlap[0]}" / "${overlap[1]}".`
          : `Tasks "${a.id}" and "${b.id}" both own "${overlap[0]}" / "${overlap[1]}", but run in sequence so they cannot collide.`,
        taskIds: [a.id, b.id],
        repairHint: concurrent
          ? `Hoist the shared part of "${overlap[0]}" into the contract, or make "${b.id}" depend on "${a.id}" so they are sequential.`
          : 'No action needed; the later task will see the earlier task merged.',
      })
    }
  }

  const contractPaths = contract.files.map((f) => normalizeGlob(f.path))
  for (const task of tasks) {
    for (const contractPath of contractPaths) {
      if (!pathMatchesAny(contractPath, task.ownedPaths)) continue
      issues.push({
        code: 'contract_path_owned_by_task',
        severity: 'error',
        message: `Task "${task.id}" owns "${contractPath}", which is a contract file.`,
        taskIds: [task.id],
        repairHint: `Contract files are committed before any task starts and must stay frozen. Narrow ${task.id}.ownedPaths to exclude "${contractPath}".`,
      })
    }

    for (const glob of task.ownedPaths) {
      const normalized = normalizeGlob(glob)
      if (!normalized.startsWith('/') && !normalized.split('/').includes('..')) continue
      issues.push({
        code: 'path_escapes_repo',
        severity: 'error',
        message: `Task "${task.id}" owns "${glob}", which points outside the repository.`,
        taskIds: [task.id],
        repairHint: 'Use a repo-relative glob with no leading slash and no "..".',
      })
    }

    if (task.acceptance.testFiles.length === 0 && task.acceptance.manualChecks.length === 0) {
      issues.push({
        code: 'missing_acceptance',
        severity: 'error',
        message: `Task "${task.id}" has a test command but names no test files and no manual checks.`,
        taskIds: [task.id],
        repairHint: `Name the spec file ${task.id} will add or extend, so the command provably fails before the task and passes after.`,
      })
    }

    if (task.estimateMinutes > MAX_TASK_MINUTES) {
      issues.push({
        code: 'oversized_task',
        severity: 'warning',
        message: `Task "${task.id}" is estimated at ${task.estimateMinutes}min, over the ${MAX_TASK_MINUTES}min target.`,
        taskIds: [task.id],
        repairHint: 'Split it behind an interface, or accept that it will hold its lease for a long stretch.',
      })
    }
  }

  // -- will everyone actually have something to do? -------------------------
  const frontierByDepth: number[] = []
  for (const depth of analysis.depthByTask.values()) {
    frontierByDepth[depth] = (frontierByDepth[depth] ?? 0) + 1
  }
  for (let i = 0; i < frontierByDepth.length; i++) frontierByDepth[i] ??= 0
  const maxFrontier = frontierByDepth.length === 0 ? 0 : Math.max(...frontierByDepth)

  if (maxFrontier < participantCount) {
    issues.push({
      code: 'narrow_frontier',
      severity: 'warning',
      message: `This issue only splits ${maxFrontier} way(s); ${participantCount - maxFrontier} of ${participantCount} devs will idle.`,
      taskIds: [],
      repairHint:
        'Either accept the idle capacity, or look for a seam that lets more work start at once -- usually a second contract file.',
    })
  }

  return {
    ok: !issues.some((issue) => issue.severity === 'error'),
    issues,
    frontierByDepth,
    maxFrontier,
  }
}
