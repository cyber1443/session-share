/**
 * Answers one question: if the shipped plugin changed, did its version change
 * with it?
 *
 * Claude Code installs a plugin into a directory keyed by the version in its
 * manifest, and skips the download when that version is already installed. So a
 * release that changes the code but not the version is not a release: every
 * `/plugin update` is a no-op, the user keeps running the old build, and the
 * only symptom is that the fixes you just shipped appear not to work. That is
 * an expensive thing to debug from the other end, so it is checked here.
 *
 *   node scripts/check-version.mjs          exit 1 if a bump is missing
 *   node scripts/check-version.mjs --quiet  same, without the explanation
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const quiet = process.argv.includes('--quiet')
const MANIFESTS = ['.claude-plugin/marketplace.json', 'packages/plugin/.claude-plugin/plugin.json']

/** Everything a user actually installs. */
const SHIPPED = ['packages/plugin/']

const git = (args) => execFileSync('git', args, { encoding: 'utf8' }).trim()

/** What is already published. Overridable so this check can be tested. */
const PUBLISHED_REF = process.env.SESSION_SHARE_PUBLISHED_REF ?? 'origin/main'

function versionOf(source) {
  const manifest = JSON.parse(source)
  return manifest.version ?? manifest.plugins?.[0]?.version ?? null
}

function published() {
  // Nothing to compare against on a fresh clone or a first push.
  try {
    git(['rev-parse', '--verify', PUBLISHED_REF])
  } catch {
    return null
  }
  try {
    return versionOf(git(['show', `${PUBLISHED_REF}:${MANIFESTS[0]}`]))
  } catch {
    return null
  }
}

const local = MANIFESTS.map((path) => versionOf(readFileSync(path, 'utf8')))
if (new Set(local).size !== 1) {
  if (!quiet) {
    console.error(`\nThe two manifests disagree about the version: ${local.join(' and ')}.\n`)
    console.error(`  ${MANIFESTS.join('\n  ')}\n`)
  }
  process.exit(1)
}

const version = local[0]
const shipped = published()

if (shipped === null || shipped !== version) {
  if (!quiet) console.log(`version ${version} is a new release`)
  process.exit(0)
}

// Same version as what is published. That is only honest if nothing shipped changed.
const changed = git(['diff', '--name-only', PUBLISHED_REF, 'HEAD', '--', ...SHIPPED])
  .split('\n')
  .filter(Boolean)

if (changed.length === 0) {
  if (!quiet) console.log(`version ${version}, and nothing shipped has changed`)
  process.exit(0)
}

if (!quiet) {
  console.error(`\nThe plugin changed but its version is still ${version}.\n`)
  console.error('Claude Code keys the install directory on that version and skips the download')
  console.error('when it already has it, so nobody would receive this. Bump it in both:\n')
  console.error(`  ${MANIFESTS.join('\n  ')}\n`)
  console.error(`${changed.length} shipped file(s) changed, including:`)
  console.error(`  ${changed.slice(0, 5).join('\n  ')}\n`)
}

process.exit(1)
