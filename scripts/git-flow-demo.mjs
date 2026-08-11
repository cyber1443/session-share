/**
 * The scenario people actually ask about: two developers, one repo cloned on
 * both machines, both on main, wanting to add dark mode together.
 *
 *   pnpm git-flow-demo
 *
 * Sets up a bare "origin" and two real clones, then drives the whole session
 * through real git: contract branch, task branches, simultaneous work, merges
 * back, and the tasks that were blocked becoming claimable.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { peerJoin, runCommand } from '../packages/plugin/dist/client.js'
import { ensureDaemon, readDaemon, stopDaemon } from '../packages/plugin/dist/daemon.js'
import {
  checkoutBranch,
  commit,
  contractBranch,
  mergeInto,
  push,
  taskBranch,
  writeFiles,
} from '../packages/plugin/dist/git.js'

const dim = (s) => `\x1b[2m${s}\x1b[0m`
const bold = (s) => `\x1b[1m${s}\x1b[0m`
const green = (s) => `\x1b[32m${s}\x1b[0m`
const red = (s) => `\x1b[31m${s}\x1b[0m`

let step = 0
const say = (t) => console.log(`\n${bold(`${++step}. ${t}`)}`)
const ok = (s) => console.log(`   ${green('✓')} ${s}`)
const no = (s) => console.log(`   ${red('✗')} ${s}`)
const note = (s) => console.log(`   ${dim(s)}`)

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

const SLUG = `dark-mode-${Date.now().toString(36)}`
const workspace = mkdtempSync(join(tmpdir(), 'ss-gitflow-'))
const origin = join(workspace, 'origin.git')
const aliceRepo = join(workspace, 'alice')
const bobRepo = join(workspace, 'bob')

const wasRunning = Boolean(readDaemon())

const contract = {
  summary: 'Theme union and storage key, imported by every task',
  files: [
    {
      path: 'src/lib/theme-types.ts',
      purpose: 'Theme union and storage key',
      contents: 'export type Theme = "light" | "dark"\nexport const THEME_KEY = "app.theme"\n',
    },
  ],
}

const tasks = [
  {
    id: 'theme-toggle',
    title: 'Theme toggle component',
    intent: 'A button that flips the theme',
    ownedPaths: ['src/components/theme-toggle/**'],
    dependsOn: [],
    assumes: ['Theme from src/lib/theme-types.ts'],
    acceptance: {
      testCommand: 'npm test -- theme-toggle',
      testFiles: ['src/components/theme-toggle/theme-toggle.test.tsx'],
      manualChecks: [],
    },
    estimateMinutes: 45,
  },
  {
    id: 'theme-persist',
    title: 'Persist the preference',
    intent: 'Store the theme and rehydrate on load',
    ownedPaths: ['src/lib/theme-storage.ts', 'src/lib/theme-storage.test.ts'],
    dependsOn: [],
    assumes: ['THEME_KEY from src/lib/theme-types.ts'],
    acceptance: {
      testCommand: 'npm test -- theme-storage',
      testFiles: ['src/lib/theme-storage.test.ts'],
      manualChecks: [],
    },
    estimateMinutes: 30,
  },
  {
    id: 'theme-docs',
    title: 'Document the theme system',
    intent: 'README section on the toggle and the storage key',
    ownedPaths: ['docs/theming.md'],
    dependsOn: ['theme-toggle', 'theme-persist'],
    assumes: [],
    acceptance: {
      testCommand: 'npm run lint:docs',
      testFiles: [],
      manualChecks: ['docs mention the storage key'],
    },
    estimateMinutes: 20,
  },
]

try {
  console.log(bold('\ntwo devs, one repo, one feature\n'))

  // -------------------------------------------------------------------------
  say('A repo on a remote, cloned by both, both on main')
  mkdirSync(origin, { recursive: true })
  git(origin, ['init', '--bare', '-b', 'main'])

  const seed = join(workspace, 'seed')
  git(workspace, ['clone', origin, seed])
  mkdirSync(join(seed, 'src'), { recursive: true })
  writeFileSync(join(seed, 'README.md'), '# acme web\n')
  writeFileSync(join(seed, 'src/app.tsx'), 'export const App = () => null\n')
  git(seed, ['add', '-A'])
  git(seed, ['-c', 'user.email=seed@x', '-c', 'user.name=Seed', 'commit', '-m', 'initial'])
  git(seed, ['push', 'origin', 'main'])

  git(workspace, ['clone', origin, aliceRepo])
  git(workspace, ['clone', origin, bobRepo])
  for (const repo of [aliceRepo, bobRepo]) {
    git(repo, ['config', 'user.email', 'dev@example.com'])
    git(repo, ['config', 'user.name', 'Dev'])
  }
  ok(`alice on ${git(aliceRepo, ['rev-parse', '--abbrev-ref', 'HEAD'])}, bob on ${git(bobRepo, ['rev-parse', '--abbrev-ref', 'HEAD'])}`)

  // -------------------------------------------------------------------------
  say('Alice hosts, Bob joins')
  const daemon = await ensureDaemon({ expose: 'loopback' })
  const server = `http://127.0.0.1:${daemon.port}`

  const created = await post(server, '/api/sessions', {
    slug: SLUG,
    title: 'Add a dark mode toggle',
    repo: { owner: 'acme', name: 'web', baseBranch: 'main', remoteUrl: origin },
    issueRef: null,
  })
  const alice = await attach(server, created.invite, 'alice', 'Alice', aliceRepo)
  const bob = await attach(server, created.invite, 'bob', 'Bob', bobRepo)
  ok('both attached, each to their own clone')

  // -------------------------------------------------------------------------
  say('Claude proposes the split; the validator checks it')
  const proposal = await runCommand(alice, {
    type: 'decomposition.propose',
    contract,
    tasks,
    participantCount: 2,
    issueRef: null,
  })
  ok(`valid: ${proposal.validation.ok}, up to ${proposal.validation.maxFrontier} at once`)

  await runCommand(alice, { type: 'decomposition.approve', decompositionId: proposal.decompositionId })
  await runCommand(bob, { type: 'decomposition.approve', decompositionId: proposal.decompositionId })
  ok('both approved')

  // -------------------------------------------------------------------------
  say('Alice lands the contract — this is what creates the feature branch')
  const contractRef = contractBranch(SLUG)
  await checkoutBranch(aliceRepo, contractRef, 'main')
  const written = await writeFiles(aliceRepo, contract.files)
  const sha = await commit(aliceRepo, written, 'contract: dark mode seam')
  await push(aliceRepo, contractRef)
  await runCommand(alice, {
    type: 'contract.committed',
    branch: contractRef,
    commitSha: sha,
    prNumber: null,
  })
  ok(`${contractRef} created from main, pushed (${sha.slice(0, 7)})`)
  note(`contains ${written.join(', ')}`)

  // -------------------------------------------------------------------------
  say('Each claims a task and lands on their own branch')
  const aliceClaim = await runCommand(alice, { type: 'task.claim', taskId: null })
  const bobClaim = await runCommand(bob, { type: 'task.claim', taskId: null })

  const aliceBranch = taskBranch(SLUG, aliceClaim.task.id)
  const bobBranch = taskBranch(SLUG, bobClaim.task.id)
  await checkoutBranch(aliceRepo, aliceBranch, contractRef)
  await checkoutBranch(bobRepo, bobBranch, contractRef)

  ok(`Alice → ${aliceClaim.task.id} on ${aliceBranch}`)
  ok(`Bob   → ${bobClaim.task.id} on ${bobBranch}`)
  note(`bob's clone fetched ${contractRef} from origin to branch off it`)

  // -------------------------------------------------------------------------
  say('Both work at the same time, inside their own leases')
  const denied = await runCommand(bob, {
    type: 'lease.check',
    paths: [`${aliceClaim.task.ownedPaths[0].replace('/**', '')}/index.tsx`],
  })
  ok(denied.allowed ? 'WARNING: bob was allowed into alice files' : `bob is blocked from alice's paths`)

  await writeFiles(aliceRepo, [
    { path: 'src/components/theme-toggle/index.tsx', contents: 'export const ThemeToggle = () => null\n' },
    { path: 'src/components/theme-toggle/theme-toggle.test.tsx', contents: 'test("renders", () => {})\n' },
  ])
  await writeFiles(bobRepo, [
    { path: 'src/lib/theme-storage.ts', contents: 'export const readTheme = () => "light"\n' },
    { path: 'src/lib/theme-storage.test.ts', contents: 'test("reads", () => {})\n' },
  ])
  ok('both wrote files, neither touched the other')

  // -------------------------------------------------------------------------
  say('Each finishes: commit, push, merge into the contract branch')
  for (const [who, repo, claim, branch] of [
    ['Alice', aliceRepo, aliceClaim, aliceBranch],
    ['Bob', bobRepo, bobClaim, bobBranch],
  ]) {
    const session = who === 'Alice' ? alice : bob
    await checkoutBranch(repo, branch, contractRef)
    const taskSha = await commit(repo, claim.task.ownedPaths, `${claim.task.id}: done`)
    await push(repo, branch)

    const merge = await mergeInto(repo, contractRef, branch)
    if (!merge.merged) {
      no(`${who}: merge conflicted on ${merge.conflicts.join(', ')}`)
      continue
    }
    await push(repo, contractRef)
    const { unblocked } = await runCommand(session, {
      type: 'task.merged',
      taskId: claim.task.id,
    })
    ok(`${who}: ${claim.task.id} merged (${taskSha.slice(0, 7)})${unblocked.length ? ` → unblocked ${unblocked.join(', ')}` : ''}`)

    // The other clone has to pull before it can branch off the new contract.
    const otherRepo = repo === aliceRepo ? bobRepo : aliceRepo
    execFileSync('git', ['fetch', 'origin'], { cwd: otherRepo })
  }

  // -------------------------------------------------------------------------
  say('The blocked task became claimable, and the DAG drains')
  await execFileSync('git', ['fetch', 'origin'], { cwd: aliceRepo })
  const docsClaim = await runCommand(alice, { type: 'task.claim', taskId: null })
  if (!docsClaim.task) {
    no(`nothing claimable: ${docsClaim.reason}`)
  } else {
    ok(`Alice → ${docsClaim.task.id} (was blocked on both of the above)`)
    const docsBranch = taskBranch(SLUG, docsClaim.task.id)
    await checkoutBranch(aliceRepo, docsBranch, contractRef)
    await writeFiles(aliceRepo, [{ path: 'docs/theming.md', contents: '# Theming\n' }])
    await commit(aliceRepo, docsClaim.task.ownedPaths, `${docsClaim.task.id}: done`)
    await push(aliceRepo, docsBranch)
    await mergeInto(aliceRepo, contractRef, docsBranch)
    await push(aliceRepo, contractRef)
    await runCommand(alice, { type: 'task.merged', taskId: docsClaim.task.id })
    ok(`${docsClaim.task.id} merged`)
  }

  // -------------------------------------------------------------------------
  say('What the feature branch actually contains')
  const snapshot = await get(server, `/sessions/${SLUG}/snapshot`, alice.participantToken)
  execFileSync('git', ['checkout', contractRef], { cwd: aliceRepo })
  const files = git(aliceRepo, ['diff', '--name-only', 'main', contractRef]).split('\n').filter(Boolean)
  const log = git(aliceRepo, ['log', '--oneline', `main..${contractRef}`]).split('\n').filter(Boolean)

  console.log(`\n   ${dim(`${contractRef} vs main — ${files.length} files, ${log.length} commits`)}`)
  for (const file of files) console.log(`     ${file}`)
  console.log(`\n   ${dim('phase: ' + snapshot.session.phase)}`)
  for (const task of snapshot.tasks) {
    console.log(`     ${task.id.padEnd(16)} ${task.state.padEnd(8)} ${task.branch ?? ''}`)
  }
  console.log(green('\nDone — that branch is what you open a PR from.\n'))
} finally {
  if (!wasRunning) stopDaemon()
  rmSync(workspace, { recursive: true, force: true })
}

async function post(server, path, body) {
  const response = await fetch(new URL(path, server), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = await response.json()
  if (!response.ok) throw new Error(payload.message ?? payload.error)
  return payload
}

async function get(server, path, token) {
  const response = await fetch(new URL(path, server), {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
  if (!response.ok) throw new Error(`GET ${path} → ${response.status}`)
  return response.json()
}

async function attach(server, invite, login, name, repoPath) {
  const result = await peerJoin(server, invite, { githubLogin: login, displayName: name }, repoPath)
  const config = {
    serverUrl: server,
    sessionRef: result.sessionRef,
    participantId: result.participantId,
    participantToken: result.participantToken,
    githubLogin: login,
    displayName: name,
    repoPath,
  }
  mkdirSync(join(repoPath, '.session-share'), { recursive: true })
  writeFileSync(join(repoPath, '.session-share/session.json'), JSON.stringify(config, null, 2))
  return config
}
