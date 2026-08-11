/**
 * End-to-end walkthrough of a two-dev session, with no UI and no GitHub.
 *
 * Runs a real coordination server, two real participants, and the real
 * PreToolUse hook binary as a subprocess -- the same way Claude Code runs it.
 *
 *   pnpm demo
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../packages/server/dist/index.js'
import { writeConfig, readConfig } from '../packages/plugin/dist/config.js'
import { pair, runCommand } from '../packages/plugin/dist/client.js'

const HOOK = new URL('../packages/plugin/dist/hook.js', import.meta.url).pathname

const dim = (s) => `\x1b[2m${s}\x1b[0m`
const bold = (s) => `\x1b[1m${s}\x1b[0m`
const green = (s) => `\x1b[32m${s}\x1b[0m`
const red = (s) => `\x1b[31m${s}\x1b[0m`
const cyan = (s) => `\x1b[36m${s}\x1b[0m`

let step = 0
const say = (title) => console.log(`\n${bold(`${++step}. ${title}`)}`)
const ok = (s) => console.log(`   ${green('✓')} ${s}`)
const no = (s) => console.log(`   ${red('✗')} ${s}`)
const note = (s) => console.log(`   ${dim(s)}`)

const app = createApp({
  dbPath: ':memory:',
  auth: { devLogin: true, secret: 'demo-secret' },
})
const baseUrl = await app.listen(0)

const aliceRepo = mkdtempSync(join(tmpdir(), 'ss-demo-alice-'))
const bobRepo = mkdtempSync(join(tmpdir(), 'ss-demo-bob-'))

/** A checkout speaking to the server, authenticated by its participant token. */
const command = (repoPath, cmd) => runCommand(readConfig(repoPath), cmd)

/** The browser half: signed in with a cookie. */
async function asUser(cookie, path, init = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    ...init,
    headers: init.body
      ? { 'content-type': 'application/json', cookie, ...init.headers }
      : { cookie, ...init.headers },
  })
  const payload = await response.json()
  if (!response.ok) throw new Error(payload.message ?? payload.error)
  return payload
}

async function signIn(login) {
  const response = await fetch(new URL('/auth/dev', baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login }),
  })
  return response.headers.get('set-cookie').split(';')[0]
}

/** Mint a one-time code in the browser, redeem it in the checkout. */
async function attach(cookie, repoPath) {
  const { token } = await asUser(cookie, '/api/sessions/dark-mode/join-token', { method: 'POST' })
  const result = await pair(baseUrl, token, repoPath)
  writeConfig(repoPath, {
    serverUrl: baseUrl,
    sessionRef: result.sessionRef,
    participantId: result.participantId,
    participantToken: result.participantToken,
    githubLogin: result.githubLogin,
    displayName: result.displayName,
    repoPath,
  })
  return { ...result, code: token }
}

/** Exactly how Claude Code invokes the gate: JSON in, JSON or nothing out. */
function runHook(cwd, toolName, filePath) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [HOOK], { cwd, stdio: ['pipe', 'pipe', 'inherit'] })
    let stdout = ''
    child.stdout.on('data', (c) => (stdout += c))
    child.on('error', reject)
    child.on('close', () => resolve(stdout.trim() ? JSON.parse(stdout) : null))
    child.stdin.end(
      JSON.stringify({ tool_name: toolName, tool_input: { file_path: filePath }, cwd }),
    )
  })
}

const contract = {
  summary: 'Theme seam: the union, the context and the storage key both tasks import',
  files: [
    {
      path: 'src/lib/theme-types.ts',
      purpose: 'Theme union and the storage key, imported by both tasks',
      contents: 'export type Theme = "light" | "dark"\nexport const THEME_KEY = "app.theme"\n',
    },
  ],
}

const goodTasks = [
  {
    id: 'theme-toggle',
    title: 'Theme toggle component',
    intent: 'A button that flips the theme and reflects the current one',
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
    intent: 'Write the theme to localStorage and rehydrate it on load',
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
    intent: 'README section covering the toggle and the storage key',
    ownedPaths: ['docs/theming.md'],
    dependsOn: ['theme-toggle', 'theme-persist'],
    assumes: [],
    acceptance: {
      testCommand: 'npm run lint:docs',
      testFiles: [],
      manualChecks: ['docs/theming.md describes the toggle and the storage key'],
    },
    estimateMinutes: 20,
  },
]

try {
  console.log(bold('\nsession-share — two devs, one issue\n'))
  console.log(dim(`server ${baseUrl}`))
  console.log(dim(`alice   ${aliceRepo}`))
  console.log(dim(`bob     ${bobRepo}`))

  // -------------------------------------------------------------------------
  say('Both devs sign in and pair a checkout')
  const aliceCookie = await signIn('alice')
  const bobCookie = await signIn('bob')
  ok('Alice and Bob signed in (GitHub in production; loopback dev login here)')

  await asUser(aliceCookie, '/api/sessions', {
    method: 'POST',
    body: JSON.stringify({
      slug: 'dark-mode',
      title: 'Add a dark mode toggle',
      repo: {
        owner: 'acme',
        name: 'web',
        baseBranch: 'main',
        remoteUrl: 'git@github.com:acme/web.git',
      },
      issueRef: 'https://github.com/acme/web/issues/42',
    }),
  })
  ok('Alice opened the session')

  const alicePairing = await attach(aliceCookie, aliceRepo)
  const bobPairing = await attach(bobCookie, bobRepo)
  note(`Alice pasted  /ss:join ${alicePairing.code.slice(0, 16)}…  into her checkout`)
  note(`Bob pasted    /ss:join ${bobPairing.code.slice(0, 16)}…  into his`)

  try {
    await pair(baseUrl, alicePairing.code, aliceRepo)
    no('the code was reusable — it should not be')
  } catch (error) {
    ok(`each code is single use — ${error.message}`)
  }
  note('each checkout now holds a participant token; the lease gate is live')

  // -------------------------------------------------------------------------
  say('A sloppy split gets rejected before any human sees it')
  const bad = await command(aliceRepo, {
    type: 'decomposition.propose',
    contract,
    tasks: [
      { ...goodTasks[0], ownedPaths: ['src/**'] },
      { ...goodTasks[1], ownedPaths: ['src/lib/**'] },
    ],
    participantCount: 2,
    issueRef: null,
  })
  for (const issue of bad.validation.issues) {
    no(`${issue.code}: ${issue.message}`)
    note(`  fix: ${issue.repairHint}`)
  }

  try {
    await command(aliceRepo, {
      type: 'decomposition.approve',
      decompositionId: bad.decompositionId,
    })
  } catch (error) {
    ok(`approval refused — ${error.message}`)
  }

  // -------------------------------------------------------------------------
  say('The repaired split passes')
  const proposal = await command(aliceRepo, {
    type: 'decomposition.propose',
    contract,
    tasks: goodTasks,
    participantCount: 2,
    issueRef: null,
  })
  ok(`valid — up to ${proposal.validation.maxFrontier} tasks can run at once`)
  for (const issue of proposal.validation.issues) note(`warning: ${issue.message}`)

  // -------------------------------------------------------------------------
  say('Both devs approve, and only then does the work become claimable')
  const first = await command(aliceRepo, {
    type: 'decomposition.approve',
    decompositionId: proposal.decompositionId,
  })
  note(`Alice approved — satisfied: ${first.satisfied} (2 devs means unanimous)`)

  await command(bobRepo, {
    type: 'decomposition.approve',
    decompositionId: proposal.decompositionId,
  })
  ok('Bob approved — tasks seeded')

  try {
    await command(bobRepo, { type: 'task.claim', taskId: null })
  } catch (error) {
    ok(`claiming still refused — ${error.message}`)
  }

  await command(aliceRepo, {
    type: 'contract.committed',
    branch: 'ss/dark-mode/contract',
    commitSha: 'a1b2c3d',
    prNumber: null,
  })
  ok('contract landed on ss/dark-mode/contract — phase is now build')

  // -------------------------------------------------------------------------
  say('Each dev is handed a different task')
  const aliceTask = await command(aliceRepo, { type: 'task.claim', taskId: null })
  ok(`Alice → ${cyan(aliceTask.task.id)}  owns ${aliceTask.lease.paths.join(', ')}`)

  try {
    await command(bobRepo, { type: 'task.claim', taskId: aliceTask.task.id })
    no('Bob stole Alice\'s task — this should be impossible')
  } catch (error) {
    ok(`Bob cannot take Alice's task — ${error.message}`)
  }

  try {
    await command(bobRepo, { type: 'task.claim', taskId: 'theme-docs' })
    no('theme-docs was claimable while blocked — this should be impossible')
  } catch (error) {
    ok(`theme-docs stays out of reach — ${error.message}`)
  }

  const bobTask = await command(bobRepo, { type: 'task.claim', taskId: null })
  ok(`Bob   → ${cyan(bobTask.task.id)}  owns ${bobTask.lease.paths.join(', ')}`)

  const capped = await command(bobRepo, { type: 'task.claim', taskId: null })
  ok(`Bob cannot hoard the frontier — ${capped.reason}`)

  // -------------------------------------------------------------------------
  say('The lease gate, running as the real hook binary')
  const own = await runHook(
    aliceRepo,
    'Edit',
    join(aliceRepo, 'src/components/theme-toggle/index.tsx'),
  )
  ok(`Alice edits her own file → ${own === null ? 'allowed' : 'DENIED'}`)

  const across = await runHook(
    bobRepo,
    'Edit',
    join(bobRepo, 'src/components/theme-toggle/index.tsx'),
  )
  no("Bob edits into Alice's task → denied")
  console.log(`     ${dim(across.hookSpecificOutput.permissionDecisionReason)}`)

  const frozen = await runHook(aliceRepo, 'Write', join(aliceRepo, 'src/lib/theme-types.ts'))
  no('Alice edits a contract file → denied, even though nobody holds it')
  console.log(`     ${dim(frozen.hookSpecificOutput.permissionDecisionReason)}`)

  const unowned = await runHook(bobRepo, 'Write', join(bobRepo, 'README.md'))
  ok(`Bob edits an unowned file → ${unowned === null ? 'allowed' : 'DENIED'}`)

  // -------------------------------------------------------------------------
  say("Bob asks for the file, Alice hands it over")
  const path = 'src/components/theme-toggle/index.tsx'
  const { request } = await command(bobRepo, {
    type: 'handoff.request',
    path,
    reason: 'need one extra prop on the toggle',
  })
  note(`request ${request.id.slice(0, 8)} — pending`)

  const stillDenied = await runHook(bobRepo, 'Edit', join(bobRepo, path))
  ok(`while pending, Bob is still blocked → ${stillDenied === null ? 'ALLOWED' : 'denied'}`)

  await command(aliceRepo, {
    type: 'handoff.resolve',
    requestId: request.id,
    granted: true,
  })
  const nowAllowed = await runHook(bobRepo, 'Edit', join(bobRepo, path))
  ok(`Alice granted it → ${nowAllowed === null ? 'allowed' : 'STILL DENIED'}`)

  const otherFile = await runHook(
    bobRepo,
    'Edit',
    join(bobRepo, 'src/components/theme-toggle/styles.css'),
  )
  ok(`but only that one file → ${otherFile === null ? 'ALLOWED' : 'denied'}`)

  // -------------------------------------------------------------------------
  say('The room: humans and agents in one timeline')
  await command(aliceRepo, {
    type: 'chat.post',
    body: 'starting on #theme-toggle, the contract has everything I need',
    taskRef: null,
    asAgent: false,
  })
  await command(bobRepo, {
    type: 'chat.post',
    body: 'THEME_KEY should probably be readonly — flagging before I build on it #theme-persist',
    taskRef: null,
    asAgent: true,
  })

  const { messages } = await command(bobRepo, {
    type: 'chat.read',
    limit: 10,
    beforeSeq: null,
    taskRef: null,
  })
  for (const message of messages) {
    const who = message.authorId === alicePairing.participantId ? 'Alice' : 'Bob'
    const kind = message.authorKind === 'agent' ? dim(' (agent)') : ''
    const ref = message.taskRef ? cyan(` #${message.taskRef}`) : ''
    console.log(`   ${who}${kind}${ref}: ${message.body}`)
  }

  // -------------------------------------------------------------------------
  say('Alice proves her task and it moves toward its PR')
  await command(aliceRepo, {
    type: 'task.progress',
    taskId: aliceTask.task.id,
    state: 'running',
    activityLine: 'writing theme-toggle.test.tsx',
  })
  await command(aliceRepo, {
    type: 'task.testResult',
    taskId: aliceTask.task.id,
    result: {
      passed: true,
      command: 'npm test -- theme-toggle',
      exitCode: 0,
      summary: '3 passing',
      ranAt: Date.now(),
    },
  })
  ok('theme-toggle passed its acceptance command → moved to pr')

  const snapshot = await asUser(aliceCookie, '/sessions/dark-mode/snapshot')
  console.log()
  for (const task of snapshot.tasks.sort((a, b) => a.depth - b.depth)) {
    const owner = snapshot.participants.find((p) => p.id === task.ownerId)
    console.log(
      `   ${dim(`depth ${task.depth}`)}  ${cyan(task.id.padEnd(16))} ${task.state.padEnd(8)} ${owner?.displayName ?? dim('unclaimed')}`,
    )
  }

  console.log(
    `\n   ${dim('theme-docs stays blocked on purpose: tasks unblock on merged, not on pr.')}`,
  )
  console.log(`   ${dim('Merging is the merge queue (P5), which is not built yet.')}`)
  console.log(`\n   ${dim(`${snapshot.seq + 1} events in the log; every table above is folded from it`)}`)
  console.log(green('\nDone.\n'))
} finally {
  await app.close()
  rmSync(aliceRepo, { recursive: true, force: true })
  rmSync(bobRepo, { recursive: true, force: true })
}
