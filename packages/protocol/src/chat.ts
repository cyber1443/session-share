import type { TaskId } from './ids.js'

const TASK_REF = /(?:^|\s)#([a-z0-9][a-z0-9-]{1,38}[a-z0-9])\b/g
const MENTION = /(?:^|\s)@([a-zA-Z0-9][a-zA-Z0-9-]{0,38})\b/g

/**
 * A `#task-id` in a message links it to a DAG node, which is how task-scoped
 * discussion happens without a second comment system bolted onto the board.
 * Only ids that exist in the session count, so a stray `#todo` stays text.
 */
export function parseTaskRefs(body: string, knownTaskIds: Iterable<string>): TaskId[] {
  const known = new Set(knownTaskIds)
  const found: TaskId[] = []
  for (const match of body.matchAll(TASK_REF)) {
    const id = match[1]!
    if (known.has(id) && !found.includes(id as TaskId)) found.push(id as TaskId)
  }
  return found
}

export function parseMentions(body: string, loginToId: Map<string, string>): string[] {
  const found: string[] = []
  for (const match of body.matchAll(MENTION)) {
    const id = loginToId.get(match[1]!)
    if (id && !found.includes(id)) found.push(id)
  }
  return found
}
