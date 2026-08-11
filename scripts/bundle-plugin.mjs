/**
 * Packs the plugin into something a teammate can install without cloning this
 * repository or running a build.
 *
 * Claude Code installs a plugin by cloning its marketplace repo and running
 * nothing. So the plugin has to arrive complete: no `node_modules`, no install
 * step, no build. esbuild flattens the server, the MCP tools and the lease-gate
 * hook into standalone files, and the exported board is copied in beside them.
 *
 * This is only possible because the server stores state in `node:sqlite`, which
 * is built into Node. A native database driver would have made a
 * dependency-free bundle impossible.
 */
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'packages/plugin/bundle')
const webOut = join(root, 'apps/web/out')

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  logLevel: 'warning',
  // Node builtins stay external; everything else is inlined.
  external: ['node:*'],
  banner: {
    // Some bundled dependencies still reach for CommonJS globals.
    js: [
      "import { createRequire as __createRequire } from 'node:module'",
      "import { fileURLToPath as __fileURLToPath } from 'node:url'",
      "import { dirname as __dirname_of } from 'node:path'",
      'const require = __createRequire(import.meta.url)',
      'const __filename = __fileURLToPath(import.meta.url)',
      'const __dirname = __dirname_of(__filename)',
    ].join('\n'),
  },
}

console.log('bundling the coordination server…')
await build({
  ...shared,
  entryPoints: [join(root, 'packages/server/src/index.ts')],
  outfile: join(out, 'server/index.js'),
})

console.log('bundling the mcp server…')
await build({
  ...shared,
  entryPoints: [join(root, 'packages/plugin/src/mcp.ts')],
  outfile: join(out, 'mcp.js'),
})

console.log('bundling the lease gate…')
await build({
  ...shared,
  entryPoints: [join(root, 'packages/plugin/src/hook.ts')],
  outfile: join(out, 'hook.js'),
})

if (!existsSync(webOut)) {
  console.error(`\nMissing ${webOut}. Run: pnpm --filter @session-share/web export`)
  process.exit(1)
}
console.log('copying the board…')
cpSync(webOut, join(out, 'web'), { recursive: true })

const sizes = ['server/index.js', 'mcp.js', 'hook.js'].map((file) => {
  const bytes = statSync(join(out, file)).size
  return `  ${file.padEnd(18)} ${(bytes / 1024).toFixed(0)} kB`
})
console.log(`\nbundled into packages/plugin/bundle:\n${sizes.join('\n')}`)
console.log('  web/               (the board)')
