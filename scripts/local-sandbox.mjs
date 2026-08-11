/**
 * Builds a throwaway two-developer setup on one machine, so you can rehearse a
 * real session with two Claude Codes before pointing any of it at a repository
 * you care about.
 *
 *   pnpm sandbox            # creates ~/session-share-sandbox
 *   pnpm sandbox /some/dir  # somewhere else
 *
 * You get a bare "origin", two clones of a tiny app, and both wired up to your
 * working copy of the plugin. Nothing here touches your real repositories.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const target = resolve(process.argv[2] ?? join(homedir(), 'session-share-sandbox'))

const bold = (s) => `\x1b[1m${s}\x1b[0m`
const dim = (s) => `\x1b[2m${s}\x1b[0m`
const green = (s) => `\x1b[32m${s}\x1b[0m`

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

if (existsSync(target)) {
  console.log(dim(`removing the previous sandbox at ${target}`))
  rmSync(target, { recursive: true, force: true })
}

mkdirSync(target, { recursive: true })
const origin = join(target, 'origin.git')
const alice = join(target, 'alice')
const bob = join(target, 'bob')

// A remote both clones share, standing in for GitHub.
mkdirSync(origin, { recursive: true })
git(origin, ['init', '--bare', '-b', 'main'])

const seed = join(target, '.seed')
git(target, ['clone', '--quiet', origin, seed])
mkdirSync(join(seed, 'src'), { recursive: true })
writeFileSync(
  join(seed, 'README.md'),
  '# sandbox app\n\nA toy app for rehearsing a session-share session.\n',
)
writeFileSync(
  join(seed, 'package.json'),
  `${JSON.stringify({ name: 'sandbox-app', private: true, scripts: { test: 'echo "no tests yet"' } }, null, 2)}\n`,
)
writeFileSync(join(seed, 'src/app.tsx'), 'export const App = () => <main>hello</main>\n')
writeFileSync(join(seed, 'src/styles.css'), ':root { color-scheme: light; }\n')
git(seed, ['add', '-A'])
git(seed, ['-c', 'user.email=seed@example.com', '-c', 'user.name=Seed', 'commit', '-q', '-m', 'initial app'])
git(seed, ['push', '--quiet', 'origin', 'main'])
rmSync(seed, { recursive: true, force: true })

for (const [name, path] of [
  ['alice', alice],
  ['bob', bob],
]) {
  git(target, ['clone', '--quiet', origin, path])
  git(path, ['config', 'user.email', `${name}@example.com`])
  git(path, ['config', 'user.name', name])
  execFileSync('node', [join(ROOT, 'scripts/attach.mjs'), path], { stdio: 'ignore' })
}

console.log(`\n${bold('Sandbox ready')} at ${target}\n`)
console.log('Two clones of the same repo, both on main, both wired to your local plugin build.\n')

console.log(bold('Terminal 1 — Alice hosts'))
console.log(`  cd ${alice}`)
console.log(`  ${dim('SESSION_SHARE_LOGIN=alice')} claude`)
console.log('  /ss:host Add a dark mode toggle')
console.log(`  ${dim('→ copy the /ss:join ssx_… line it prints')}\n`)

console.log(bold('Terminal 2 — Bob joins'))
console.log(`  cd ${bob}`)
console.log(`  ${dim('SESSION_SHARE_LOGIN=bob')} claude`)
console.log('  /ss:join ssx_…\n')

console.log(bold('Then, in either'))
console.log('  /ss:plan add a dark mode toggle')
console.log(`  ${dim('approve on the board, then:')}`)
console.log('  /ss:land            (whoever planned)')
console.log('  /ss:next            (both)')
console.log('  /ss:done            (each, when their acceptance test passes)')
console.log('  /ss:ship\n')

console.log(
  `${bold('Why the env var:')} identity comes from ${dim('gh')}, so without it both\n` +
    'Claude Codes are the same GitHub account, the server correctly treats them as\n' +
    'one participant, and the leases never collide — the rehearsal would prove nothing.\n',
)

console.log(`${bold('Board:')} the URL /ss:host prints. Open it twice if you want to watch both seats.\n`)
console.log(green(`Delete it all with: rm -rf ${target}\n`))
