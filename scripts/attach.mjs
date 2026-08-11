/**
 * Wires a target repository up to session-share for a real Claude Code run:
 * the MCP server, the PreToolUse lease gate, and the /ss:* commands.
 *
 *   pnpm attach /path/to/your/repo
 *
 * Everything it writes is additive -- existing settings, hooks and MCP servers
 * are merged, never replaced. Re-running it is safe.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const target = process.argv[2]
if (!target) {
  console.error('usage: pnpm attach <path-to-repo>')
  process.exit(1)
}

const repo = resolve(target)
if (!existsSync(repo)) {
  console.error(`No such directory: ${repo}`)
  process.exit(1)
}

const pluginRoot = resolve(dirname(new URL(import.meta.url).pathname), '..', 'packages', 'plugin')
const hookPath = join(pluginRoot, 'dist', 'hook.js')
const mcpPath = join(pluginRoot, 'dist', 'mcp.js')

if (!existsSync(hookPath) || !existsSync(mcpPath)) {
  console.error('Build first: pnpm build')
  process.exit(1)
}

const readJson = (path, fallback) => {
  if (!existsSync(path)) return fallback
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    console.error(`Could not parse ${path}; fix or move it and re-run.`)
    process.exit(1)
  }
}

const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

const written = []

// -- MCP server --------------------------------------------------------------
const mcpConfigPath = join(repo, '.mcp.json')
const mcpConfig = readJson(mcpConfigPath, {})
mcpConfig.mcpServers ??= {}
mcpConfig.mcpServers['session-share'] = {
  command: 'node',
  args: [mcpPath],
  env: { SESSION_SHARE_REPO: repo },
}
writeJson(mcpConfigPath, mcpConfig)
written.push('.mcp.json (session-share MCP server)')

// -- the lease gate ----------------------------------------------------------
const settingsPath = join(repo, '.claude', 'settings.json')
const settings = readJson(settingsPath, {})
settings.hooks ??= {}
settings.hooks.PreToolUse ??= []

const command = `node ${hookPath}`
const already = settings.hooks.PreToolUse.some((entry) =>
  entry.hooks?.some((hook) => hook.command === command),
)
if (!already) {
  settings.hooks.PreToolUse.push({
    matcher: 'Edit|Write|MultiEdit|NotebookEdit',
    hooks: [{ type: 'command', command, timeout: 5 }],
  })
  writeJson(settingsPath, settings)
  written.push('.claude/settings.json (PreToolUse lease gate)')
} else {
  written.push('.claude/settings.json (lease gate already present)')
}

// -- slash commands ----------------------------------------------------------
const commandsSource = join(pluginRoot, 'commands')
const commandsTarget = join(repo, '.claude', 'commands', 'ss')
mkdirSync(commandsTarget, { recursive: true })
const names = readdirSync(commandsSource).filter((f) => f.endsWith('.md'))
for (const name of names) copyFileSync(join(commandsSource, name), join(commandsTarget, name))
written.push(`.claude/commands/ss/ (${names.map((n) => `/ss:${n.replace('.md', '')}`).join(', ')})`)

// -- ignore the session file -------------------------------------------------
const gitignorePath = join(repo, '.gitignore')
const gitignore = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : ''
if (!gitignore.includes('.session-share')) {
  writeFileSync(gitignorePath, `${gitignore}${gitignore.endsWith('\n') || gitignore === '' ? '' : '\n'}.session-share/\n`)
  written.push('.gitignore (+ .session-share/)')
}

console.log(`\nAttached ${repo}\n`)
for (const line of written) console.log(`  ${line}`)
console.log(`
Next:
  1. Start the server:   pnpm server
  2. Open Claude Code in ${repo}
  3. /ss:join <session-slug> http://127.0.0.1:4310

To create the session in the first place, one participant runs:
  curl -s localhost:4310/api/commands -H 'content-type: application/json' \\
    -d '{"sessionRef":"my-session","command":{"type":"session.create","slug":"my-session","title":"My issue","repo":{"owner":"me","name":"repo","baseBranch":"main","remoteUrl":"git@github.com:me/repo.git"},"issueRef":null}}'
`)
