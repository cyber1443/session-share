/**
 * Checks that the committed bundle is what this source actually builds.
 *
 * Run in CI after a fresh `pnpm bundle`, against a clean checkout.
 *
 * The guarantee is deliberately split, because the two halves are not equally
 * reproducible:
 *
 *   - The three executable files (the coordination server, the MCP server and
 *     the lease-gate hook) come from esbuild and are byte-identical across
 *     platforms. These are the supply-chain surface that matters: they are what
 *     runs on a machine as a server, as an MCP process, and on every file edit.
 *     Any difference here fails the build.
 *
 *   - The board is a Next.js static export whose chunk filenames embed content
 *     hashes that differ between macOS and Linux. Asserting byte-equality there
 *     would mean a permanently failing check that everyone learns to ignore,
 *     which is worse than no check. Instead the route set is compared, so a
 *     page appearing or vanishing is still caught.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = 'packages/plugin/bundle'

const EXECUTABLES = [`${BUNDLE}/server`, `${BUNDLE}/mcp.js`, `${BUNDLE}/hook.js`]

function changedFiles(paths) {
  const output = execFileSync('git', ['diff', '--name-only', '--', ...paths], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  return output.split('\n').filter(Boolean)
}

/** Every route the export produced, ignoring hashed asset filenames. */
function routes(root) {
  const found = []
  const walk = (dir) => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) {
        if (entry === '_next') continue
        walk(path)
      } else if (entry.endsWith('.html')) {
        found.push(relative(root, path))
      }
    }
  }
  walk(root)
  return found.sort()
}

let failed = false

const executableDrift = changedFiles(EXECUTABLES)
if (executableDrift.length > 0) {
  console.error('::error::The committed executables do not match a build from this source.')
  console.error('These are what run on a contributor machine, so they must reproduce exactly.\n')
  for (const file of executableDrift) console.error(`  ${file}`)
  console.error('\n  pnpm bundle && git add packages/plugin/bundle && git commit\n')
  failed = true
} else {
  console.log('Executables reproduce byte-for-byte from source:')
  for (const path of EXECUTABLES) console.log(`  ${path}`)
}

const boardRoutes = routes(join(ROOT, BUNDLE, 'web'))
// `trailingSlash: true` emits the not-found page both ways.
const expected = ['404.html', '404/index.html', 'board/index.html', 'index.html']
const missing = expected.filter((route) => !boardRoutes.includes(route))
const unexpected = boardRoutes.filter((route) => !expected.includes(route))

if (missing.length > 0 || unexpected.length > 0) {
  console.error('\n::error::The board export does not have the routes it should.')
  if (missing.length) console.error(`  missing: ${missing.join(', ')}`)
  if (unexpected.length) console.error(`  unexpected: ${unexpected.join(', ')}`)
  failed = true
} else {
  console.log(`\nBoard export has its expected routes (${boardRoutes.join(', ')}).`)
  console.log("Chunk hashes are platform-dependent and are not compared.")
}

process.exit(failed ? 1 : 0)
