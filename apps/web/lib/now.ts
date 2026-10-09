import type { Doing, Participant } from '@session-share/protocol'

/** Older than this, a "now" line is history and is not shown as current. */
export const NOW_FRESH_MS = 10 * 60 * 1000

export function ago(ts: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - ts) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.round(minutes / 60)}h ago`
}

/** Whether a line says the agent is working, as opposed to waiting. */
export const isBusy = (doing: Doing | undefined, now = Date.now()) =>
  Boolean(doing && now - doing.at < NOW_FRESH_MS && !doing.text.startsWith('idle'))

/** The members of something who have a Claude working right now, with what. */
export function workingNow(
  members: Participant[],
  doing: Record<string, Doing> | undefined,
  now = Date.now(),
): Array<{ member: Participant; doing: Doing }> {
  return members
    .filter((member) => member.repoPath && isBusy(doing?.[member.id], now))
    .map((member) => ({ member, doing: doing![member.id]! }))
}
