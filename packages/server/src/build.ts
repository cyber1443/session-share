import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * A fingerprint of the code this process is actually running.
 *
 * The daemon outlives the Claude Code that started it -- that is the point of
 * it -- which means it also outlives a plugin update. Updating the plugin and
 * then finding nothing has changed is the failure this exists to prevent: the
 * new tools talk to the old server, and the board the old server serves is the
 * old board. Publishing the build lets a client notice and restart it.
 *
 * Hashes every module beside the entry point, so it changes in the monorepo's
 * multi-file dist as well as in the single bundled file users install.
 */
export function computeBuildId(entry: string = process.argv[1] ?? ''): string {
  if (!entry || !existsSync(entry)) return 'unknown'

  const hash = createHash('sha256')
  try {
    const dir = dirname(entry)
    const files = readdirSync(dir)
      .filter((name) => name.endsWith('.js'))
      .sort()
    for (const name of files) {
      const path = join(dir, name)
      if (!statSync(path).isFile()) continue
      hash.update(name)
      hash.update(readFileSync(path))
    }
  } catch {
    return 'unknown'
  }
  return hash.digest('hex').slice(0, 12)
}

/**
 * Frozen at startup, on purpose.
 *
 * Recomputing per request would report whatever is on disk *now*, so a server
 * still running yesterday's code would cheerfully claim today's build the
 * moment the files were replaced -- which is precisely the situation this is
 * meant to detect. What matters is the code this process loaded.
 */
const BUILD = computeBuildId()

export function buildId(): string {
  return BUILD
}
