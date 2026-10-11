export const DAY_MS = 24 * 60 * 60 * 1000

/** Midnight, local time, of the day a timestamp falls on. */
export function startOfDay(ts: number): number {
  const date = new Date(ts)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** `2026-10-11`, for a date input. */
export function toDateInput(ts: number | null): string {
  if (ts === null) return ''
  const date = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** A date input's value as local midnight, or null when it is empty. */
export function fromDateInput(value: string): number | null {
  if (!value) return null
  const [year, month, day] = value.split('-').map(Number)
  if (!year || !month || !day) return null
  return new Date(year, month - 1, day).getTime()
}

/** `Oct 11`, short enough for a card. */
export function shortDate(ts: number): string {
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' })
}
