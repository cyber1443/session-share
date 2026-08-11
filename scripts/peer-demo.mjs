/**
 * The peer flow, exactly as two people would hit it: one hosts, the other pastes
 * one string. No OAuth App, no second process, nothing to configure.
 *
 *   pnpm peer-demo
 *
 * Runs against a real daemon on this machine and cleans it up afterwards.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unpackInvite } from '../packages/protocol/dist/index.js'
import { peerJoin, runCommand } from '../packages/plugin/dist/client.js'
import { ensureDaemon, lanAddress, readDaemon, stopDaemon } from '../packages/plugin/dist/daemon.js'

const dim = (s) => `\x1b[2m${s}\x1b[0m`
const bold = (s) => `\x1b[1m${s}\x1b[0m`
const green = (s) => `\x1b[32m${s}\x1b[0m`
const red = (s) => `\x1b[31m${s}\x1b[0m`

let step = 0
const say = (t) => console.log(`\n${bold(`${++step}. ${t}`)}`)
const ok = (s) => console.log(`   ${green('✓')} ${s}`)
const no = (s) => console.log(`   ${red('✗')} ${s}`)
const note = (s) => console.log(`   ${dim(s)}`)

// The host's database persists between runs, so each demo gets its own session.
const SLUG = `peer-demo-${Date.now().toString(36)}`

const hostRepo = mkdtempSync(join(tmpdir(), 'peer-host-'))
const guestRepo = mkdtempSync(join(tmpdir(), 'peer-guest-'))

const wasRunning = Boolean(readDaemon())

try {
  console.log(bold('\nsession-share — peer mode\n'))

  // -------------------------------------------------------------------------
  say('Host runs /ss:host — a server appears without anyone installing one')
  const daemon = await ensureDaemon({ expose: 'lan' })
  const loopback = `http://127.0.0.1:${daemon.port}`
  ok(`server up on ${daemon.url}`)
  note(lanAddress() ? `reachable on this network at ${daemon.url}` : 'no LAN address; loopback only')

  const created = await create(loopback, {
    slug: SLUG,
    title: 'Add a dark mode toggle',
    repo: { owner: 'acme', name: 'web', baseBranch: 'main', remoteUrl: 'git@github.com:acme/web.git' },
    issueRef: null,
  })
  ok('session created')

  const packed = pack(daemon.url, created.invite)
  note(`invite: /ss:join ${packed.slice(0, 34)}…`)

  const host = await peerJoin(
    loopback,
    created.invite,
    { githubLogin: 'alice', displayName: 'Alice' },
    hostRepo,
  )
  write(hostRepo, loopback, host)
  ok(`host attached as ${host.displayName} — no login, name read from their machine`)

  // -------------------------------------------------------------------------
  say('Guest pastes that one string, and nothing else')
  const unpacked = unpackInvite(packed)
  if (!unpacked) throw new Error('the invite did not unpack')
  ok(`the string carries the address too: ${unpacked.url}`)

  const guest = await peerJoin(
    loopback,
    unpacked.token,
    { githubLogin: 'bob', displayName: 'Bob' },
    guestRepo,
  )
  write(guestRepo, loopback, guest)
  ok(`guest attached as ${guest.displayName}`)

  // -------------------------------------------------------------------------
  say('The invite is reusable, unlike a hosted join code')
  const again = await peerJoin(
    loopback,
    unpacked.token,
    { githubLogin: 'bob', displayName: 'Bob' },
    guestRepo,
  )
  ok(
    again.participantId === guest.participantId
      ? 'rejoining with the same handle returns the same participant, not a duplicate'
      : 'WARNING: rejoining created a second participant',
  )

  // -------------------------------------------------------------------------
  say('Guards still hold')
  try {
    await peerJoin(loopback, unpacked.token, { githubLogin: 'carol', displayName: 'Carol' }, hostRepo)
    no('a third person took over the host working tree — should be impossible')
  } catch (error) {
    ok(`one checkout per person — ${error.message}`)
  }

  try {
    await peerJoin(loopback, 'ssx_not_a_real_invite', { githubLogin: 'mallory', displayName: 'M' }, guestRepo)
    no('an invented invite was accepted')
  } catch (error) {
    ok(`invites are signed — ${error.message}`)
  }

  // Dialled over the LAN interface, so the server sees a genuinely non-loopback
  // socket -- the check is on the connection, not on a forgeable header.
  if (lanAddress()) {
    const remote = await fetch(new URL('/api/sessions', daemon.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        slug: 'not-yours',
        title: 'nope',
        repo: { owner: 'a', name: 'b', baseBranch: 'main', remoteUrl: 'x' },
        issueRef: null,
      }),
    })
    if (remote.status === 403) {
      ok('only the hosting machine can create sessions (403 over the LAN interface)')
    } else {
      no(`a remote caller created a session (${remote.status})`)
    }
  } else {
    note('no LAN address available; skipped the remote-creation check')
  }

  // -------------------------------------------------------------------------
  say('And it is the same session underneath')
  const hostCfg = read(hostRepo)
  const guestCfg = read(guestRepo)

  const proposal = await runCommand(hostCfg, {
    type: 'decomposition.propose',
    contract: {
      summary: 'Theme seam',
      files: [{ path: 'src/lib/theme-types.ts', purpose: 'Theme union', contents: 'export type Theme = "light"\n' }],
    },
    tasks: [
      task('theme-toggle', ['src/components/theme-toggle/**']),
      task('theme-persist', ['src/lib/theme-storage.ts']),
    ],
    participantCount: 2,
    issueRef: null,
  })
  ok(`split validated: ${proposal.validation.ok}`)

  await runCommand(hostCfg, { type: 'decomposition.approve', decompositionId: proposal.decompositionId })
  await runCommand(guestCfg, { type: 'decomposition.approve', decompositionId: proposal.decompositionId })
  await runCommand(hostCfg, {
    type: 'contract.committed',
    branch: `ss/${SLUG}/contract`,
    commitSha: 'abc1234',
    prNumber: null,
  })
  await runCommand(hostCfg, { type: 'task.claim', taskId: 'theme-toggle' })

  const denied = await runCommand(guestCfg, {
    type: 'lease.check',
    paths: ['src/components/theme-toggle/index.tsx'],
  })
  ok(
    !denied.allowed
      ? `lease gate works across the peer link — ${denied.denials[0].message}`
      : 'WARNING: the guest was allowed into the host task',
  )

  console.log(`\n   ${dim(`Board: ${daemon.url}/board/?join=${packed.slice(0, 24)}…`)}`)
  console.log(green('\nDone.\n'))
} finally {
  if (!wasRunning) stopDaemon()
  rmSync(hostRepo, { recursive: true, force: true })
  rmSync(guestRepo, { recursive: true, force: true })
}

function task(id, paths) {
  return {
    id,
    title: id,
    intent: id,
    ownedPaths: paths,
    dependsOn: [],
    assumes: ['Theme from src/lib/theme-types.ts'],
    acceptance: { testCommand: `npm test -- ${id}`, testFiles: [`${id}.test.ts`], manualChecks: [] },
    estimateMinutes: 40,
  }
}

async function create(url, body) {
  const response = await fetch(new URL('/api/sessions', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = await response.json()
  if (!response.ok) throw new Error(payload.message ?? payload.error)
  return payload
}

function pack(url, token) {
  const payload = JSON.stringify({ u: url.replace(/\/$/, ''), t: token })
  return `ssx_${Buffer.from(payload, 'utf8').toString('base64url')}`
}

function write(repoPath, serverUrl, result) {
  mkdirSync(join(repoPath, '.session-share'), { recursive: true })
  writeFileSync(
    join(repoPath, '.session-share', 'session.json'),
    JSON.stringify(
      {
        serverUrl,
        sessionRef: result.sessionRef,
        participantId: result.participantId,
        participantToken: result.participantToken,
        githubLogin: result.githubLogin,
        displayName: result.displayName,
        repoPath,
      },
      null,
      2,
    ),
  )
}

function read(repoPath) {
  return JSON.parse(readFileSync(join(repoPath, '.session-share', 'session.json'), 'utf8'))
}
