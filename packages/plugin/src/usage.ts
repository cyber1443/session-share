import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * What this session has cost, taken from the transcript Claude Code writes.
 *
 * Nobody proxies inference here: each person's agent runs on their own account.
 * That is the right design and it makes one question unanswerable from the
 * inside -- who is this costing, and for which piece of work. The `Stop` hook is
 * handed the path to the transcript, and every assistant message in it carries
 * its own usage, so the answer is already on disk.
 *
 * Read-only, and never leaves the machine as anything but four numbers: no
 * prompt, no completion, no file content.
 */
export interface UsageDelta {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  turns: number
}

const EMPTY: UsageDelta = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  turns: 0,
}

function stateDir(): string {
  return process.env.SESSION_SHARE_HOME ?? join(homedir(), '.session-share')
}

const offsetsFile = () => join(stateDir(), 'usage.json')

type Offsets = Record<string, number>

function readOffsets(): Offsets {
  const path = offsetsFile()
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Offsets
  } catch {
    return {}
  }
}

function writeOffset(transcript: string, bytes: number): void {
  mkdirSync(stateDir(), { recursive: true })
  writeFileSync(offsetsFile(), `${JSON.stringify({ ...readOffsets(), [transcript]: bytes }, null, 2)}\n`)
}

/**
 * Usage written since the last time this transcript was read.
 *
 * Tracked by byte offset rather than by line: transcripts are append-only, so
 * re-reading from the top on every turn would re-count the whole session and
 * grow quadratically in a long one.
 */
export function usageSince(transcriptPath: string | undefined): UsageDelta {
  if (!transcriptPath || !existsSync(transcriptPath)) return EMPTY

  let size: number
  try {
    size = statSync(transcriptPath).size
  } catch {
    return EMPTY
  }

  const seen = readOffsets()[transcriptPath] ?? 0
  // Truncated or replaced underneath us: start again rather than read garbage.
  const from = seen > size ? 0 : seen
  if (from === size) return EMPTY

  let text: string
  try {
    text = readFileSync(transcriptPath, 'utf8').slice(from)
  } catch {
    return EMPTY
  }

  const delta = { ...EMPTY }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let entry: { message?: { usage?: Record<string, number> } }
    try {
      entry = JSON.parse(line)
    } catch {
      continue // a half-written last line; the next read picks it up
    }
    const usage = entry.message?.usage
    if (!usage) continue

    delta.inputTokens += usage.input_tokens ?? 0
    delta.outputTokens += usage.output_tokens ?? 0
    delta.cacheReadTokens += usage.cache_read_input_tokens ?? 0
    delta.cacheCreationTokens += usage.cache_creation_input_tokens ?? 0
    delta.turns += 1
  }

  writeOffset(transcriptPath, size)
  return delta
}
