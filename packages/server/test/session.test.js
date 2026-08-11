import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { createApp } from '../dist/index.js'
import { TestClient, expectError, settle } from './client.js'

const REPO = {
  owner: 'acme',
  name: 'web',
  baseBranch: 'main',
  remoteUrl: 'git@github.com:acme/web.git',
}

const contract = {
  summary: 'Theme types and provider stub',
  files: [
    { path: 'src/lib/theme-types.ts', purpose: 'shared Theme union', contents: 'export type Theme = "light" | "dark"\n' },
  ],
}

const tasks = [
  {
    id: 'theme-toggle',
    title: 'Theme toggle component',
    intent: 'Add a toggle that flips the theme',
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
    title: 'Persist theme preference',
    intent: 'Store the theme in localStorage and rehydrate on load',
    ownedPaths: ['src/lib/theme-storage.ts', 'src/lib/theme-storage.test.ts'],
    dependsOn: [],
    assumes: ['Theme from src/lib/theme-types.ts'],
    acceptance: {
      testCommand: 'npm test -- theme-storage',
      testFiles: ['src/lib/theme-storage.test.ts'],
      manualChecks: [],
    },
    estimateMinutes: 30,
  },
  {
    id: 'theme-docs',
    title: 'Document theming',
    intent: 'README section on the theme system',
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

let app
let url

before(async () => {
  app = createApp({ dbPath: ':memory:' })
  const address = await app.listen(0)
  url = `${address.replace('http://', 'ws://')}/ws`
})

after(async () => {
  await app.close()
})

/** Two devs joined to a fresh session. */
async function twoDevSession(slug) {
  const alice = await new TestClient(url).connect()
  const bob = await new TestClient(url).connect()

  await alice.send({ type: 'session.create', slug, title: 'Dark mode', repo: REPO, issueRef: '#42' })
  const aliceJoin = await alice.send({
    type: 'session.join',
    sessionRef: slug,
    githubLogin: 'alice',
    displayName: 'Alice',
    repoPath: '/tmp/alice/web',
    fromSeq: null,
  })
  const bobJoin = await bob.send({
    type: 'session.join',
    sessionRef: slug,
    githubLogin: 'bob',
    displayName: 'Bob',
    repoPath: '/tmp/bob/web',
    fromSeq: null,
  })
  await settle()
  return { alice, bob, aliceId: aliceJoin.participantId, bobId: bobJoin.participantId }
}

/** Walk a session all the way to the build phase with tasks seeded. */
async function buildPhaseSession(slug) {
  const session = await twoDevSession(slug)
  const { alice, bob } = session

  const proposal = await alice.send({
    type: 'decomposition.propose',
    contract,
    tasks,
    participantCount: 2,
    issueRef: '#42',
  })
  assert.equal(proposal.validation.ok, true, JSON.stringify(proposal.validation.issues, null, 2))

  await alice.send({ type: 'decomposition.approve', decompositionId: proposal.decompositionId })
  const second = await bob.send({
    type: 'decomposition.approve',
    decompositionId: proposal.decompositionId,
  })
  assert.equal(second.satisfied, true)

  await alice.send({
    type: 'contract.committed',
    branch: `ss/${slug}/contract`,
    commitSha: 'abc1234',
    prNumber: null,
  })
  await settle()
  return { ...session, decompositionId: proposal.decompositionId }
}

describe('joining', () => {
  it('gives a fresh client the full snapshot', async () => {
    const { alice } = await twoDevSession('join-snapshot')
    const snapshot = await alice.send({
      type: 'session.join',
      sessionRef: 'join-snapshot',
      githubLogin: 'alice',
      displayName: 'Alice',
      repoPath: '/tmp/alice/web',
      fromSeq: null,
    })
    assert.equal(snapshot.snapshot.session.slug, 'join-snapshot')
    assert.equal(snapshot.snapshot.participants.length, 2)
  })

  it('makes the first joiner the lead', async () => {
    const { alice, aliceId } = await twoDevSession('join-lead')
    const snapshot = await alice.send({
      type: 'session.join',
      sessionRef: 'join-lead',
      githubLogin: 'alice',
      displayName: 'Alice',
      repoPath: '/tmp/alice/web',
      fromSeq: null,
    })
    assert.equal(snapshot.snapshot.session.leadId, aliceId)
  })

  it('refuses two participants sharing one working tree', async () => {
    await twoDevSession('join-clash')
    const carol = await new TestClient(url).connect()
    const error = await expectError(
      carol.send({
        type: 'session.join',
        sessionRef: 'join-clash',
        githubLogin: 'carol',
        displayName: 'Carol',
        repoPath: '/tmp/alice/web',
        fromSeq: null,
      }),
      'conflict',
    )
    assert.match(error.message, /separate clone or git worktree/)
    await carol.close()
  })
})

describe('decomposition', () => {
  it('records a failing proposal and blocks approval on it', async () => {
    const { alice } = await twoDevSession('decomp-invalid')
    const colliding = [
      { ...tasks[0], ownedPaths: ['src/**'] },
      { ...tasks[1], ownedPaths: ['src/lib/**'] },
    ]

    const proposal = await alice.send({
      type: 'decomposition.propose',
      contract,
      tasks: colliding,
      participantCount: 2,
      issueRef: null,
    })
    assert.equal(proposal.validation.ok, false)
    assert.ok(proposal.validation.issues.some((i) => i.code === 'overlapping_paths'))

    const error = await expectError(
      alice.send({ type: 'decomposition.approve', decompositionId: proposal.decompositionId }),
      'not_ready',
    )
    assert.match(error.message, /validation errors/)
  })

  it('needs both devs to approve, then seeds the DAG', async () => {
    const { alice, bob } = await twoDevSession('decomp-approve')
    const proposal = await alice.send({
      type: 'decomposition.propose',
      contract,
      tasks,
      participantCount: 2,
      issueRef: null,
    })

    const first = await alice.send({
      type: 'decomposition.approve',
      decompositionId: proposal.decompositionId,
    })
    assert.equal(first.satisfied, false, 'one approval out of two is not enough')

    const second = await bob.send({
      type: 'decomposition.approve',
      decompositionId: proposal.decompositionId,
    })
    assert.equal(second.satisfied, true)
    await settle()

    const seeded = alice.eventsOfType('tasks.seeded').at(-1)
    assert.ok(seeded, 'approval should seed tasks')
    const byId = new Map(seeded.body.tasks.map((t) => [t.id, t]))
    assert.equal(byId.get('theme-toggle').state, 'ready')
    assert.equal(byId.get('theme-docs').state, 'blocked')
    assert.equal(byId.get('theme-docs').depth, 1)
  })

  it('keeps tasks unclaimable until the contract lands', async () => {
    const { alice, bob } = await twoDevSession('decomp-phase')
    const proposal = await alice.send({
      type: 'decomposition.propose',
      contract,
      tasks,
      participantCount: 2,
      issueRef: null,
    })
    await alice.send({ type: 'decomposition.approve', decompositionId: proposal.decompositionId })
    await bob.send({ type: 'decomposition.approve', decompositionId: proposal.decompositionId })

    await expectError(alice.send({ type: 'task.claim', taskId: null }), 'not_ready')
  })
})

describe('claiming', () => {
  it('hands two devs two different tasks', async () => {
    const { alice, bob } = await buildPhaseSession('claim-split')
    const aliceClaim = await alice.send({ type: 'task.claim', taskId: null })
    const bobClaim = await bob.send({ type: 'task.claim', taskId: null })

    assert.ok(aliceClaim.task)
    assert.ok(bobClaim.task)
    assert.notEqual(aliceClaim.task.id, bobClaim.task.id)
    assert.deepEqual(aliceClaim.lease.paths, aliceClaim.task.ownedPaths)
  })

  it('rejects a claim on a task someone already holds', async () => {
    const { alice, bob } = await buildPhaseSession('claim-race')
    const claimed = await alice.send({ type: 'task.claim', taskId: null })
    const error = await expectError(
      bob.send({ type: 'task.claim', taskId: claimed.task.id }),
      'conflict',
    )
    assert.match(error.message, /already held by Alice/)
  })

  it('refuses to hand over a blocked task', async () => {
    const { alice } = await buildPhaseSession('claim-blocked')
    const error = await expectError(
      alice.send({ type: 'task.claim', taskId: 'theme-docs' }),
      'conflict',
    )
    assert.match(error.message, /blocked on theme-toggle, theme-persist/)
  })

  it('holds one dev to one active task', async () => {
    const { alice } = await buildPhaseSession('claim-cap')
    await alice.send({ type: 'task.claim', taskId: null })
    const second = await alice.send({ type: 'task.claim', taskId: null })
    assert.equal(second.task, null)
    assert.match(second.reason, /already hold 1 active task/)
  })

  it('frees the task again on release', async () => {
    const { alice, bob } = await buildPhaseSession('claim-release')
    const claimed = await alice.send({ type: 'task.claim', taskId: null })
    await alice.send({ type: 'task.release', taskId: claimed.task.id })
    const reclaimed = await bob.send({ type: 'task.claim', taskId: claimed.task.id })
    assert.equal(reclaimed.task.id, claimed.task.id)
  })
})

describe('the lease gate', () => {
  it('lets the holder edit its own paths', async () => {
    const { alice } = await buildPhaseSession('lease-own')
    await alice.send({ type: 'task.claim', taskId: 'theme-toggle' })
    const result = await alice.send({
      type: 'lease.check',
      paths: ['src/components/theme-toggle/index.tsx'],
    })
    assert.equal(result.allowed, true)
    assert.deepEqual(result.denials, [])
  })

  it('denies an edit inside another dev task, with the fix in the message', async () => {
    const { alice, bob } = await buildPhaseSession('lease-deny')
    await alice.send({ type: 'task.claim', taskId: 'theme-toggle' })
    const result = await bob.send({
      type: 'lease.check',
      paths: ['src/components/theme-toggle/index.tsx'],
    })

    assert.equal(result.allowed, false)
    assert.equal(result.denials[0].heldByTaskId, 'theme-toggle')
    assert.match(result.denials[0].message, /owned by Alice/)
    assert.match(result.denials[0].message, /\/ss:request/)
  })

  it('surfaces the denial to the whole session', async () => {
    const { alice, bob } = await buildPhaseSession('lease-broadcast')
    await alice.send({ type: 'task.claim', taskId: 'theme-toggle' })
    await bob.send({ type: 'lease.check', paths: ['src/components/theme-toggle/index.tsx'] })
    await settle()
    assert.equal(alice.eventsOfType('lease.denied').length, 1)
  })

  it('freezes contract files for everyone during build', async () => {
    const { alice } = await buildPhaseSession('lease-contract')
    await alice.send({ type: 'task.claim', taskId: 'theme-toggle' })
    const result = await alice.send({ type: 'lease.check', paths: ['src/lib/theme-types.ts'] })
    assert.equal(result.allowed, false)
    assert.match(result.denials[0].message, /frozen for the build phase/)
  })

  it('allows an unowned path', async () => {
    const { bob } = await buildPhaseSession('lease-unowned')
    const result = await bob.send({ type: 'lease.check', paths: ['README.md'] })
    assert.equal(result.allowed, true)
  })
})

describe('handoff', () => {
  it('opens the path once the holder grants it', async () => {
    const { alice, bob } = await buildPhaseSession('handoff-grant')
    await alice.send({ type: 'task.claim', taskId: 'theme-toggle' })
    const path = 'src/components/theme-toggle/index.tsx'

    const { request } = await bob.send({
      type: 'handoff.request',
      path,
      reason: 'need one prop added',
    })
    assert.equal(request.holderId, (await aliceIdOf(alice, 'handoff-grant')))

    const denied = await bob.send({ type: 'lease.check', paths: [path] })
    assert.equal(denied.allowed, false, 'a pending request must not open the path')

    await alice.send({ type: 'handoff.resolve', requestId: request.id, granted: true })
    const allowed = await bob.send({ type: 'lease.check', paths: [path] })
    assert.equal(allowed.allowed, true)
  })

  it('only lets the holder resolve it', async () => {
    const { alice, bob } = await buildPhaseSession('handoff-forbidden')
    await alice.send({ type: 'task.claim', taskId: 'theme-toggle' })
    const { request } = await bob.send({
      type: 'handoff.request',
      path: 'src/components/theme-toggle/index.tsx',
      reason: '',
    })
    await expectError(
      bob.send({ type: 'handoff.resolve', requestId: request.id, granted: true }),
      'forbidden',
    )
  })
})

describe('chat', () => {
  it('links a #task-id in the body to the DAG node', async () => {
    const { alice } = await buildPhaseSession('chat-ref')
    const { message } = await alice.send({
      type: 'chat.post',
      body: 'hoisting the variant into the contract, blocks #theme-toggle',
      taskRef: null,
      asAgent: false,
    })
    assert.equal(message.taskRef, 'theme-toggle')
  })

  it('ignores a # that is not a real task', async () => {
    const { alice } = await buildPhaseSession('chat-noref')
    const { message } = await alice.send({
      type: 'chat.post',
      body: 'adding a #todo here',
      taskRef: null,
      asAgent: false,
    })
    assert.equal(message.taskRef, null)
  })

  it('marks agent posts so humans can tell who is talking', async () => {
    const { alice } = await buildPhaseSession('chat-agent')
    const { message } = await alice.send({
      type: 'chat.post',
      body: 'theme-storage.ts needs a third variant',
      taskRef: null,
      asAgent: true,
    })
    assert.equal(message.authorKind, 'agent')
  })

  it('reaches the other dev live and reads back in order', async () => {
    const { alice, bob } = await buildPhaseSession('chat-live')
    await alice.send({ type: 'chat.post', body: 'first', taskRef: null, asAgent: false })
    await bob.send({ type: 'chat.post', body: 'second', taskRef: null, asAgent: false })
    await settle()

    assert.equal(bob.eventsOfType('chat.message').length, 2)
    const { messages } = await bob.send({
      type: 'chat.read',
      limit: 50,
      beforeSeq: null,
      taskRef: null,
    })
    assert.deepEqual(
      messages.map((m) => m.body),
      ['first', 'second'],
    )
  })

  it('filters history down to one task', async () => {
    const { alice } = await buildPhaseSession('chat-filter')
    await alice.send({ type: 'chat.post', body: 'about #theme-toggle', taskRef: null, asAgent: false })
    await alice.send({ type: 'chat.post', body: 'unrelated', taskRef: null, asAgent: false })
    const { messages } = await alice.send({
      type: 'chat.read',
      limit: 50,
      beforeSeq: null,
      taskRef: 'theme-toggle',
    })
    assert.equal(messages.length, 1)
    assert.equal(messages[0].body, 'about #theme-toggle')
  })
})

describe('activity relay', () => {
  it('relays frames to peers without persisting them', async () => {
    const { alice, bob, aliceId } = await buildPhaseSession('activity-relay')
    const before = alice.events.length + bob.events.length

    bob.frames.length = 0
    alice.frame({
      type: 'agent.line',
      from: aliceId,
      taskId: 'theme-toggle',
      text: 'editing theme-toggle.tsx',
      ts: Date.now(),
    })
    await settle()

    assert.equal(bob.frames.length, 1)
    assert.equal(bob.frames[0].text, 'editing theme-toggle.tsx')
    assert.equal(alice.events.length + bob.events.length, before, 'frames are never logged')
  })

  it('does not echo a frame back to its sender', async () => {
    const { alice, aliceId } = await buildPhaseSession('activity-echo')
    alice.frames.length = 0
    alice.frame({ type: 'attention', from: aliceId, taskId: 'theme-toggle', ts: Date.now() })
    await settle()
    assert.equal(alice.frames.length, 0)
  })
})

describe('reconnect', () => {
  it('replays the backlog in order from lastSeq', async () => {
    const { alice, bob } = await buildPhaseSession('reconnect-sync')
    await alice.send({ type: 'task.claim', taskId: 'theme-toggle' })
    const lastSeq = bob.events.at(-1).seq

    await bob.close()
    await settle()

    // Things happen while Bob is away.
    await alice.send({ type: 'chat.post', body: 'while you were out', taskRef: null, asAgent: false })
    await alice.send({
      type: 'task.progress',
      taskId: 'theme-toggle',
      state: 'running',
      activityLine: 'writing the toggle',
    })

    const bobAgain = await new TestClient(url).connect()
    await bobAgain.send({
      type: 'session.join',
      sessionRef: 'reconnect-sync',
      githubLogin: 'bob',
      displayName: 'Bob',
      repoPath: '/tmp/bob/web',
      fromSeq: lastSeq + 1,
    })
    await settle()

    const replayed = bobAgain.syncs.flatMap((s) => s.events)
    assert.ok(replayed.length > 0, 'expected a backlog')
    assert.deepEqual(
      replayed.map((e) => e.seq),
      [...replayed.map((e) => e.seq)].sort((a, b) => a - b),
      'backlog must be seq-ordered',
    )
    assert.ok(replayed.every((e) => e.seq > lastSeq), 'backlog must not repeat seen events')
    assert.ok(replayed.some((e) => e.body.type === 'chat.message'))
    assert.equal(bobAgain.syncs.at(-1).more, false)
    await bobAgain.close()
  })

  it('marks a participant disconnected when their socket drops', async () => {
    const { alice, bob, bobId } = await buildPhaseSession('reconnect-presence')
    await bob.close()
    await settle()

    const drop = alice
      .eventsOfType('participant.connection')
      .find((e) => e.body.participantId === bobId && e.body.connected === false)
    assert.ok(drop, 'peers must see the disconnect')
  })

  it('rebuilds identical state from the log alone', async () => {
    const { alice } = await buildPhaseSession('reconnect-fold')
    await alice.send({ type: 'task.claim', taskId: 'theme-toggle' })
    await alice.send({ type: 'chat.post', body: 'hello', taskRef: null, asAgent: false })
    await settle()

    const sessionId = app.store.findSessionIdByRef('reconnect-fold')
    const live = app.service.state(sessionId).snapshot()

    // Drop the projection and fold the log again from scratch.
    app.service.states?.delete?.(sessionId)
    const { SessionState } = await import('../dist/projection.js')
    const rebuilt = new SessionState()
    for (const envelope of app.store.readEvents(sessionId, 0)) rebuilt.apply(envelope)

    assert.equal(rebuilt.seq, live.seq)
    assert.equal(rebuilt.tasks.get('theme-toggle').state, 'claimed')
    assert.equal(rebuilt.leases.size, 1)
    assert.equal(rebuilt.chat.length, 1)
  })
})

/** The lead is whoever created the session, which every test does as Alice. */
async function aliceIdOf(client, slug) {
  const result = await client.send({
    type: 'session.join',
    sessionRef: slug,
    githubLogin: 'alice',
    displayName: 'Alice',
    repoPath: '/tmp/alice/web',
    fromSeq: null,
  })
  return result.participantId
}
