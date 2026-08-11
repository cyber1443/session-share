/**
 * Fingerprints everything the shipped bundle is built from.
 *
 * The bundle is committed build output, so it can silently fall behind the
 * source it came from — and the failure lands on a teammate, who installs a
 * plugin that does not match this repo. A stamp makes "is it stale" a question
 * a script can answer instead of something to remember.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const STAMP_PATH = join(ROOT, 'packages/plugin/bundle/.stamp')

/** Sources that end up inside the bundle, directly or through a dependency. */
const INPUTS = [
  'packages/protocol/src',
  'packages/server/src',
  'packages/plugin/src',
  'packages/plugin/commands',
  'packages/plugin/hooks',
  'packages/plugin/.mcp.json',
  'packages/plugin/.claude-plugin',
  'apps/web/app',
  'apps/web/components',
  'apps/web/lib',
  'apps/web/next.config.mjs',
  'apps/web/tailwind.config.ts',
  'packages/protocol/package.json',
  'packages/server/package.json',
  'packages/plugin/package.json',
  'apps/web/package.json',
]

function walk(path, files = []) {
  if (!existsSync(path)) return files
  const stats = statSync(path)
  if (stats.isFile()) {
    files.push(path)
    return files
  }
  for (const entry of readdirSync(path).sort()) {
    walk(join(path, entry), files)
  }
  return files
}

export function computeHash() {
  const hash = createHash('sha256')
  for (const input of INPUTS) {
    for (const file of walk(join(ROOT, input))) {
      hash.update(file.slice(ROOT.length))
      hash.update(readFileSync(file))
    }
  }
  return hash.digest('hex')
}

export function readStamp() {
  if (!existsSync(STAMP_PATH)) return null
  return readFileSync(STAMP_PATH, 'utf8').trim()
}
