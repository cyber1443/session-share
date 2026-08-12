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

describe('planning from the board', () => {
  it('hands the brief to a participant with a checkout', async () => {
    const { alice, bob, aliceId } = await twoDevSession('plan-request')
    const result = await bob.send({
      type: 'plan.request',
      goal: 'Add due dates to todos',
      issueRef: null,
      plannerId: null,
    })
    // The lead is Alice: she created the session.
    assert.equal(result.plannerId, aliceId)
    await settle()

    const requested = alice.eventsOfType('plan.requested').at(-1)
    assert.equal(requested.body.goal, 'Add due dates to todos')

    /**
     * The browser cannot read a repo, so the request only means anything if it
     * reaches an agent that can. It travels as a directive, like any other
     * instruction from the room.
     */
    const directive = alice
      .eventsOfType('chat.message')
      .map((event) => event.body.message)
      .findLast((message) => message.directive)
    assert.ok(directive, 'the request has to arrive somewhere')
    assert.deepEqual(directive.mentions, [aliceId])
    assert.match(directive.body, /Add due dates to todos/)
    assert.match(directive.body, /ss_propose/)
  })

  it('records the brief on the session so the board can show it', async () => {
    const { alice } = await twoDevSession('plan-goal')
    await alice.send({
      type: 'plan.request',
      goal: 'Ship dark mode',
      issueRef: 'https://github.com/acme/web/issues/42',
      plannerId: null,
    })
    const snapshot = await alice.send({
      type: 'session.join',
      sessionRef: 'plan-goal',
      githubLogin: 'alice',
      displayName: 'Alice',
      repoPath: '/tmp/alice/web',
      fromSeq: null,
    })
    assert.equal(snapshot.snapshot.session.goal, 'Ship dark mode')
    assert.equal(snapshot.snapshot.session.issueRef, 'https://github.com/acme/web/issues/42')
  })

  it('refuses to hand planning to someone with no checkout', async () => {
    const { alice } = await twoDevSession('plan-no-checkout')
    const watcher = await new TestClient(url).connect()
    const joined = await watcher.send({
      type: 'session.join',
      sessionRef: 'plan-no-checkout',
      githubLogin: 'cara',
      displayName: 'Cara',
      repoPath: null,
      fromSeq: null,
    })

    const error = await expectError(
      alice.send({
        type: 'plan.request',
        goal: 'anything',
        issueRef: null,
        plannerId: joined.participantId,
      }),
      'not_ready',
    )
    assert.match(error.message, /no checkout attached/)
    await watcher.close()
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

  it('proposes who does what as soon as a split arrives', async () => {
    const { alice, aliceId, bobId } = await twoDevSession('decomp-assign')
    await alice.send({
      type: 'decomposition.propose',
      contract,
      tasks,
      participantCount: 2,
      issueRef: null,
    })
    await settle()

    const assigned = alice.eventsOfType('decomposition.assigned').at(-1)
    assert.ok(assigned, 'a split with nobody on it leaves the team to negotiate')
    assert.equal(assigned.body.assignments.length, tasks.length, 'every task goes to someone')

    const by = Object.fromEntries(
      assigned.body.assignments.map((a) => [a.taskId, a.participantId]),
    )
    assert.notEqual(
      by['theme-toggle'],
      by['theme-persist'],
      'two tasks that can run at once must not land on one person',
    )
    for (const owner of Object.values(by)) assert.ok([aliceId, bobId].includes(owner))
  })

  it('lets a person move a card, and keeps it moved', async () => {
    const { alice, bob, aliceId } = await twoDevSession('decomp-move')
    await alice.send({
      type: 'decomposition.propose',
      contract,
      tasks,
      participantCount: 2,
      issueRef: null,
    })
    await settle()

    const moved = await bob.send({
      type: 'task.assign',
      taskId: 'theme-toggle',
      participantId: aliceId,
    })
    const pinned = moved.assignments.find((a) => a.taskId === 'theme-toggle')
    assert.equal(pinned.participantId, aliceId)
    assert.equal(pinned.manual, true, 'a hand-placed card is pinned against the next rebalance')

    // Moving another card must not undo it.
    const again = await bob.send({
      type: 'task.assign',
      taskId: 'theme-docs',
      participantId: aliceId,
    })
    assert.equal(
      again.assignments.find((a) => a.taskId === 'theme-toggle').participantId,
      aliceId,
    )
  })

  it('carries the assignment onto the live tasks and tells each agent', async () => {
    const { alice, bob, aliceId, bobId } = await twoDevSession('decomp-dispatch')
    const proposal = await alice.send({
      type: 'decomposition.propose',
      contract,
      tasks,
      participantCount: 2,
      issueRef: null,
    })
    await alice.send({ type: 'decomposition.approve', decompositionId: proposal.decompositionId })
    await bob.send({ type: 'decomposition.approve', decompositionId: proposal.decompositionId })
    await settle()

    const seeded = alice.eventsOfType('tasks.seeded').at(-1)
    assert.ok(
      seeded.body.tasks.every((task) => task.assigneeId),
      'approval turns the arrangement into work, so every task knows whose it is',
    )

    /**
     * The point of approving on the board is that nobody then has to walk over
     * and say "we approved it". Each assignee is told, in their own session.
     */
    const directives = alice
      .eventsOfType('chat.message')
      .map((event) => event.body.message)
      .filter((message) => message.directive)
    assert.equal(directives.length, 2, 'one briefing each')
    assert.deepEqual(
      directives.flatMap((message) => message.mentions).sort(),
      [aliceId, bobId].sort(),
    )
    assert.match(directives[0].body, /The split was approved/)
  })

  it('hands you your own task first', async () => {
    const { alice, bob, aliceId } = await twoDevSession('decomp-pick')
    const proposal = await alice.send({
      type: 'decomposition.propose',
      contract,
      tasks,
      participantCount: 2,
      issueRef: null,
    })
    // Put both ready tasks on Alice, so affinity cannot explain the result.
    await alice.send({ type: 'task.assign', taskId: 'theme-toggle', participantId: aliceId })
    await alice.send({ type: 'task.assign', taskId: 'theme-persist', participantId: aliceId })
    await alice.send({ type: 'decomposition.approve', decompositionId: proposal.decompositionId })
    await bob.send({ type: 'decomposition.approve', decompositionId: proposal.decompositionId })
    await alice.send({
      type: 'contract.committed',
      branch: 'ss/decomp-pick/contract',
      commitSha: 'abc1234',
      prNumber: null,
    })

    const mine = await alice.send({ type: 'task.claim', taskId: null })
    assert.equal(mine.task.assigneeId, aliceId, 'an assignment has to survive into /ss:next')
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

  it('marks a directive and resolves who it is aimed at', async () => {
    const { alice, bobId } = await buildPhaseSession('chat-directive')
    const plain = await alice.send({
      type: 'chat.post',
      body: 'anyone looked at the storage key yet',
      taskRef: null,
      asAgent: false,
    })
    assert.equal(plain.message.directive, false, 'talking is the default; driving is not')

    const aimed = await alice.send({
      type: 'chat.post',
      body: '@bob add a test for the empty case',
      taskRef: null,
      asAgent: false,
      directive: true,
    })
    assert.equal(aimed.message.directive, true)
    assert.deepEqual(aimed.message.mentions, [bobId])
  })

  it('reaches the other dev live and reads back in order', async () => {
    const { alice, bob } = await buildPhaseSession('chat-live')
    await alice.send({ type: 'chat.post', body: 'first', taskRef: null, asAgent: false })
    await bob.send({ type: 'chat.post', body: 'second', taskRef: null, asAgent: false })
    await settle()

    // The session briefs each agent in the same room, so filter to what people said.
    const said = (messages) => messages.filter((m) => m.authorKind !== 'system').map((m) => m.body)

    assert.deepEqual(
      said(bob.eventsOfType('chat.message').map((e) => e.body.message)),
      ['first', 'second'],
    )
    const { messages } = await bob.send({
      type: 'chat.read',
      limit: 50,
      beforeSeq: null,
      taskRef: null,
    })
    assert.deepEqual(said(messages), ['first', 'second'])
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
    assert.deepEqual(
      rebuilt.chat.map((m) => m.body),
      live.chat.map((m) => m.body),
      'the room folds back identically, briefings included',
    )
    assert.equal(rebuilt.tasks.get('theme-toggle').assigneeId, live.tasks.find((t) => t.id === 'theme-toggle').assigneeId)
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

describe('merging', () => {
  it('unblocks whatever was waiting on the task', async () => {
    const { alice, bob } = await buildPhaseSession('merge-unblocks')
    await alice.send({ type: 'task.claim', taskId: 'theme-toggle' })
    await bob.send({ type: 'task.claim', taskId: 'theme-persist' })

    const first = await alice.send({ type: 'task.merged', taskId: 'theme-toggle' })
    assert.deepEqual(first.unblocked, [], 'theme-docs still waits on the other one')

    const second = await bob.send({ type: 'task.merged', taskId: 'theme-persist' })
    assert.deepEqual(second.unblocked, ['theme-docs'], 'the last dependency landing frees it')
  })

  it('releases the lease so the paths are editable again', async () => {
    const { alice, bob } = await buildPhaseSession('merge-releases')
    await alice.send({ type: 'task.claim', taskId: 'theme-toggle' })

    const before = await bob.send({
      type: 'lease.check',
      paths: ['src/components/theme-toggle/index.tsx'],
    })
    assert.equal(before.allowed, false)

    await alice.send({ type: 'task.merged', taskId: 'theme-toggle' })
    const after = await bob.send({
      type: 'lease.check',
      paths: ['src/components/theme-toggle/index.tsx'],
    })
    assert.equal(after.allowed, true, 'merged work is no longer anyone task')
  })

  it('refuses to merge a task someone else holds', async () => {
    const { alice, bob } = await buildPhaseSession('merge-forbidden')
    // Alice created the session and is therefore the lead, who may land
    // anything; Bob is an ordinary participant and may not.
    await alice.send({ type: 'task.claim', taskId: 'theme-toggle' })
    await expectError(bob.send({ type: 'task.merged', taskId: 'theme-toggle' }), 'forbidden')
  })

  it('lets the session lead land a task that is stuck', async () => {
    const { alice, bob } = await buildPhaseSession('merge-lead')
    await bob.send({ type: 'task.claim', taskId: 'theme-persist' })
    // Alice created the session, so she is the lead.
    const result = await alice.send({ type: 'task.merged', taskId: 'theme-persist' })
    assert.ok(result)
  })

  it('is idempotent', async () => {
    const { alice } = await buildPhaseSession('merge-twice')
    await alice.send({ type: 'task.claim', taskId: 'theme-toggle' })
    await alice.send({ type: 'task.merged', taskId: 'theme-toggle' })
    const again = await alice.send({ type: 'task.merged', taskId: 'theme-toggle' })
    assert.deepEqual(again.unblocked, [])
  })

  it('moves the session to integrate once everything has landed', async () => {
    const { alice, bob } = await buildPhaseSession('merge-phase')
    await alice.send({ type: 'task.claim', taskId: 'theme-toggle' })
    await bob.send({ type: 'task.claim', taskId: 'theme-persist' })
    await alice.send({ type: 'task.merged', taskId: 'theme-toggle' })
    await bob.send({ type: 'task.merged', taskId: 'theme-persist' })
    await alice.send({ type: 'task.claim', taskId: 'theme-docs' })
    await alice.send({ type: 'task.merged', taskId: 'theme-docs' })
    await settle()

    const phase = alice.eventsOfType('session.phase').at(-1)
    assert.equal(phase.body.phase, 'integrate')
  })
})

/**
 * The board people actually use: anyone opens a ticket, whoever wants in joins,
 * and nothing else is asked of them. No approval step exists here on purpose --
 * joining is the consent, so everything after it has to be automatic.
 */
describe('tickets', () => {
  const open = (client, title, body = '') =>
    client.send({ type: 'ticket.create', title, body })

  it('tells the others a ticket exists without hijacking their agents', async () => {
    const { alice, bob, aliceId, bobId } = await twoDevSession('ticket-notify')
    const { ticket } = await open(alice, 'Add due dates')
    await settle()

    assert.equal(ticket.authorId, aliceId)
    assert.deepEqual(ticket.members, [aliceId], 'the author is in it from the start')
    assert.equal(ticket.state, 'plan')

    const message = bob
      .eventsOfType('chat.message')
      .map((event) => event.body.message)
      .at(-1)
    assert.match(message.body, /Join it on the board/)
    assert.deepEqual(message.mentions, [bobId])
    assert.equal(
      message.directive,
      false,
      'joining is a decision, so the invitation must not drive their agent',
    )
  })

  it('starts splitting the moment someone joins', async () => {
    const { alice, bob, aliceId } = await twoDevSession('ticket-join')
    const { ticket } = await open(alice, 'Add due dates')

    const joined = await bob.send({ type: 'ticket.join', ticketId: ticket.id })
    assert.equal(joined.ticket.members.length, 2)
    assert.equal(joined.plannerId, aliceId, 'the caller is told who was asked to split it')
    await settle()

    const state = alice.eventsOfType('ticket.state').at(-1)
    assert.equal(state.body.state, 'splitting')

    const directive = alice
      .eventsOfType('chat.message')
      .map((event) => event.body.message)
      .findLast((m) => m.directive)
    assert.deepEqual(directive.mentions, [aliceId], 'the split goes to someone with a checkout')
    assert.match(directive.body, new RegExp(ticket.id))
    assert.match(directive.body, /goes on the board for one of them to start/)
  })

  it('re-sends the request when asked again, instead of doing nothing', async () => {
    const { alice, bob, aliceId } = await twoDevSession('ticket-again')
    const { ticket } = await open(alice, 'Add due dates')
    await bob.send({ type: 'ticket.join', ticketId: ticket.id })
    await settle()
    const first = alice.eventsOfType('chat.message').filter((e) => e.body.message.directive).length

    /**
     * Pressing "ask again" while it is already splitting used to return early,
     * so the button did nothing while the card claimed an agent was working.
     */
    const again = await bob.send({ type: 'ticket.start', ticketId: ticket.id })
    assert.equal(again.plannerId, aliceId)
    await settle()

    const now = alice.eventsOfType('chat.message').filter((e) => e.body.message.directive).length
    assert.equal(now, first + 1, 'asking again has to actually ask again')
  })

  it('does not re-ask once a split exists', async () => {
    const { alice, bob } = await twoDevSession('ticket-nore-ask')
    const { ticket } = await open(alice, 'Add due dates')
    await bob.send({ type: 'ticket.join', ticketId: ticket.id })
    await alice.send({
      type: 'decomposition.propose',
      contract,
      tasks,
      participantCount: 2,
      issueRef: null,
      ticketId: ticket.id,
    })
    const again = await alice.send({ type: 'ticket.start', ticketId: ticket.id })
    assert.equal(again.plannerId, null, 'there is nothing to ask for; the split is on the board')
  })

  it('splits alone when there is nobody else to wait for', async () => {
    const solo = await new TestClient(url).connect()
    await solo.send({
      type: 'session.create',
      slug: 'ticket-solo',
      title: 'Solo',
      repo: REPO,
      issueRef: null,
    })
    await solo.send({
      type: 'session.join',
      sessionRef: 'ticket-solo',
      githubLogin: 'alice',
      displayName: 'Alice',
      repoPath: '/tmp/alice/solo',
      fromSeq: null,
    })
    const { ticket } = await open(solo, 'Just me')
    assert.equal(ticket.state, 'splitting', 'waiting for a join that cannot come would deadlock')
    await solo.close()
  })

  it('goes live on a valid split, with no approval anywhere', async () => {
    const { alice, bob, aliceId, bobId } = await twoDevSession('ticket-live')
    const { ticket } = await open(alice, 'Add due dates')
    await bob.send({ type: 'ticket.join', ticketId: ticket.id })

    const proposal = await alice.send({
      type: 'decomposition.propose',
      contract,
      tasks,
      participantCount: 2,
      issueRef: null,
      ticketId: ticket.id,
    })
    assert.equal(proposal.validation.ok, true)
    await settle()

    // The split is shown before it runs, and starting it is itself a directive
    // so a session running unattended can carry on.
    const waiting = alice.eventsOfType('ticket.state').at(-1)
    assert.equal(waiting.body.state, 'proposed', 'the split is put in front of a person first')
    assert.equal(alice.eventsOfType('tasks.seeded').length, 0, 'and nothing runs until it is started')

    const toStart = alice
      .eventsOfType('chat.message')
      .map((event) => event.body.message)
      .findLast((m) => m.directive)
    assert.match(toStart.body, /ss_ticket_approve/)
    assert.deepEqual(toStart.mentions.sort(), [aliceId, bobId].sort())

    await bob.send({ type: 'ticket.approve', ticketId: ticket.id })
    await settle()

    const seeded = alice.eventsOfType('tasks.seeded').at(-1)
    assert.ok(seeded, 'starting it is what seeds the work')
    assert.ok(
      seeded.body.tasks.every((task) => task.ticketId === ticket.id),
      'tasks belong to the ticket they came from',
    )
    assert.ok(
      seeded.body.tasks.every((task) => [aliceId, bobId].includes(task.assigneeId)),
      'and are shared out between the people who joined',
    )

    const column = alice.eventsOfType('ticket.state').at(-1)
    assert.equal(column.body.state, 'building', 'the card moves because the work moved')
  })

  it('refuses to start work an overlapping split would break', async () => {
    const { alice, bob } = await twoDevSession('ticket-invalid')
    const { ticket } = await open(alice, 'Collide')
    await bob.send({ type: 'ticket.join', ticketId: ticket.id })

    const proposal = await alice.send({
      type: 'decomposition.propose',
      contract,
      tasks: [
        { ...tasks[0], ownedPaths: ['src/**'] },
        { ...tasks[1], ownedPaths: ['src/lib/**'] },
      ],
      participantCount: 2,
      issueRef: null,
      ticketId: ticket.id,
    })
    assert.equal(proposal.validation.ok, false)
    await settle()

    assert.equal(
      alice.eventsOfType('tasks.seeded').length,
      0,
      'skipping approval must not mean skipping the validator',
    )
  })

  it('moves the card to review when the last task lands, and asks for the PR', async () => {
    const { alice, bob, aliceId } = await twoDevSession('ticket-review')
    const { ticket } = await open(alice, 'Add due dates')
    await bob.send({ type: 'ticket.join', ticketId: ticket.id })
    await alice.send({
      type: 'decomposition.propose',
      contract,
      tasks,
      participantCount: 2,
      issueRef: null,
      ticketId: ticket.id,
    })
    await alice.send({ type: 'ticket.approve', ticketId: ticket.id })
    await alice.send({
      type: 'contract.committed',
      branch: 'ss/ticket-review/contract',
      commitSha: 'abc1234',
      prNumber: null,
    })

    // Land every task, whoever holds it.
    for (const spec of tasks) {
      const claim = await alice.send({ type: 'task.claim', taskId: spec.id }).catch(() => null)
      const client = claim?.task ? alice : bob
      if (!claim?.task) await client.send({ type: 'task.claim', taskId: spec.id })
      await client.send({ type: 'task.merged', taskId: spec.id })
    }
    await settle()

    /**
     * Every task passing its own acceptance command proves each piece works
     * alone. Going straight to a PR on that basis is the whole risk of
     * splitting work up.
     */
    const column = alice.eventsOfType('ticket.state').at(-1)
    assert.equal(column.body.state, 'verify')

    const run = alice
      .eventsOfType('chat.message')
      .map((event) => event.body.message)
      .findLast((m) => m.directive)
    assert.deepEqual(run.mentions, [aliceId])
    assert.match(run.body, /exercise the feature end to end/)
    assert.match(run.body, /simulator or emulator/)
    assert.match(run.body, /ss_ticket_verified/)
    assert.doesNotMatch(run.body, /ss_ship/, 'nothing is shipped before it has been run')
  })

  it('sends a broken assembly back to everyone who built it', async () => {
    const { alice, bob, aliceId, bobId } = await verifiableTicket('ticket-broken')

    const failed = await alice.send({
      type: 'ticket.verified',
      ticketId: (await currentTicket(alice, 'ticket-broken')).id,
      passed: false,
      how: 'pnpm dev, then drove the todo list in the browser',
      summary: 'The toggle renders but the stored theme never comes back after a reload.',
    })
    assert.equal(failed.ticket.state, 'verify', 'it stays put until it actually works')
    await settle()

    const back = alice
      .eventsOfType('chat.message')
      .map((event) => event.body.message)
      .findLast((m) => m.directive)
    assert.deepEqual(
      back.mentions.sort(),
      [aliceId, bobId].sort(),
      'the person who ran it rarely owns the file that broke',
    )
    assert.match(back.body, /never comes back after a reload/)
  })

  it('sends it to review once it has actually been run', async () => {
    const { alice, aliceId } = await verifiableTicket('ticket-verified')
    const ticket = await currentTicket(alice, 'ticket-verified')

    const passed = await alice.send({
      type: 'ticket.verified',
      ticketId: ticket.id,
      passed: true,
      how: 'pnpm dev, toggled the theme and reloaded',
      summary: 'Persists across a reload and follows the system default.',
    })
    assert.equal(passed.ticket.state, 'review')
    await settle()

    const ship = alice
      .eventsOfType('chat.message')
      .map((event) => event.body.message)
      .findLast((m) => m.directive)
    assert.deepEqual(ship.mentions, [aliceId])
    assert.match(ship.body, /ss_ship/)
  })

  it('refuses a split that would fight another ticket for the same files', async () => {
    const { alice, bob } = await twoDevSession('ticket-collide')
    const first = await open(alice, 'Theme work')
    await bob.send({ type: 'ticket.join', ticketId: first.ticket.id })
    await alice.send({
      type: 'decomposition.propose',
      contract,
      tasks,
      participantCount: 2,
      issueRef: null,
      ticketId: first.ticket.id,
    })
    await alice.send({ type: 'ticket.approve', ticketId: first.ticket.id })

    const second = await open(bob, 'Something else that touches the toggle')
    await alice.send({ type: 'ticket.join', ticketId: second.ticket.id })
    const clash = await bob.send({
      type: 'decomposition.propose',
      contract,
      tasks: [{ ...tasks[0], id: 'other-toggle' }],
      participantCount: 2,
      issueRef: null,
      ticketId: second.ticket.id,
    })

    /**
     * Each split is fine on its own; together they send two agents at one file.
     * The lease gate would catch it eventually, but only once someone tried to
     * claim -- long after the work was handed out.
     */
    assert.equal(clash.validation.ok, false)
    const issue = clash.validation.issues.find((i) => i.code === 'overlaps_other_ticket')
    assert.ok(issue, JSON.stringify(clash.validation.issues))
    assert.match(issue.message, /Theme work/)
    await settle()
    assert.equal(
      bob.eventsOfType('tasks.seeded').filter((e) => e.body.tasks[0]?.ticketId === second.ticket.id)
        .length,
      0,
      'nothing from a colliding split may go live',
    )
  })

  it('lets the arrangement be changed before it runs, across the ticket only', async () => {
    const { alice, bob, aliceId, bobId } = await twoDevSession('ticket-reassign')
    const watcher = await new TestClient(url).connect()
    await watcher.send({
      type: 'session.join',
      sessionRef: 'ticket-reassign',
      githubLogin: 'cara',
      displayName: 'Cara',
      repoPath: '/tmp/cara/web',
      fromSeq: null,
    })

    const { ticket } = await open(alice, 'Add due dates')
    await bob.send({ type: 'ticket.join', ticketId: ticket.id })
    await alice.send({
      type: 'decomposition.propose',
      contract,
      tasks,
      participantCount: 2,
      issueRef: null,
      ticketId: ticket.id,
    })

    const moved = await bob.send({
      type: 'task.assign',
      taskId: 'theme-toggle',
      participantId: bobId,
    })
    assert.equal(
      moved.assignments.find((a) => a.taskId === 'theme-toggle').participantId,
      bobId,
      'anyone in the ticket can change who does what, before it starts',
    )

    /**
     * Cara is in the session but not in this ticket. Rebalancing must not hand
     * her work she never opted into.
     */
    const owners = new Set(moved.assignments.map((a) => a.participantId))
    assert.deepEqual([...owners].sort(), [aliceId, bobId].sort())

    await alice.send({ type: 'ticket.approve', ticketId: ticket.id })
    await settle()
    const seeded = alice.eventsOfType('tasks.seeded').at(-1)
    assert.equal(
      seeded.body.tasks.find((t) => t.id === 'theme-toggle').assigneeId,
      bobId,
      'and the change is what runs',
    )
    await watcher.close()
  })

  it('refuses to start a ticket you have not joined', async () => {
    const { alice, bob } = await twoDevSession('ticket-outsider')
    const { ticket } = await open(alice, 'Add due dates')
    await alice.send({
      type: 'decomposition.propose',
      contract,
      tasks,
      participantCount: 1,
      issueRef: null,
      ticketId: ticket.id,
    })

    const error = await expectError(
      bob.send({ type: 'ticket.approve', ticketId: ticket.id }),
      'forbidden',
    )
    assert.match(error.message, /Join the ticket/)
  })

  /** A ticket with every task landed, sitting in verify. */
  async function verifiableTicket(slug) {
    const session = await twoDevSession(slug)
    const { alice, bob } = session
    const { ticket } = await open(alice, 'Add due dates')
    await bob.send({ type: 'ticket.join', ticketId: ticket.id })
    await alice.send({
      type: 'decomposition.propose',
      contract,
      tasks,
      participantCount: 2,
      issueRef: null,
      ticketId: ticket.id,
    })
    await alice.send({ type: 'ticket.approve', ticketId: ticket.id })
    await alice.send({
      type: 'contract.committed',
      branch: `ss/${slug}/contract`,
      commitSha: 'abc1234',
      prNumber: null,
    })
    for (const spec of tasks) {
      const claim = await alice.send({ type: 'task.claim', taskId: spec.id }).catch(() => null)
      const client = claim?.task ? alice : bob
      if (!claim?.task) await client.send({ type: 'task.claim', taskId: spec.id })
      await client.send({ type: 'task.merged', taskId: spec.id })
    }
    await settle()
    return session
  }

  const currentTicket = async (client, slug) => {
    const joined = await client.send({
      type: 'session.join',
      sessionRef: slug,
      githubLogin: 'alice',
      displayName: 'Alice',
      repoPath: '/tmp/alice/web',
      fromSeq: null,
    })
    return joined.snapshot.tickets.at(-1)
  }

  /**
   * Review is the last column. Nothing here merges anything, so a card that
   * closed itself on `ss_ship` would be claiming an outcome nobody decided.
   */
  it('keeps a ticket in review with its PR open', async () => {
    const { alice, aliceId } = await verifiableTicket('ticket-pr')
    const ticket = await currentTicket(alice, 'ticket-pr')
    await alice.send({
      type: 'ticket.verified',
      ticketId: ticket.id,
      passed: true,
      how: 'ran it',
      summary: 'works',
    })

    const shipped = await alice.send({
      type: 'ticket.shipped',
      ticketId: ticket.id,
      prNumber: 42,
    })
    assert.equal(shipped.ticket.prNumber, 42)
    assert.equal(shipped.ticket.state, 'review', 'it waits there until a person merges it')

    // And it stays there: nothing later moves it on by itself.
    const later = await currentTicket(alice, 'ticket-pr')
    assert.equal(later.state, 'review')
    assert.ok(aliceId)
  })

  it('will not let someone walk away from work they are holding', async () => {
    const { alice, bob } = await twoDevSession('ticket-leave')
    const { ticket } = await open(alice, 'Add due dates')
    await bob.send({ type: 'ticket.join', ticketId: ticket.id })
    await alice.send({
      type: 'decomposition.propose',
      contract,
      tasks,
      participantCount: 2,
      issueRef: null,
      ticketId: ticket.id,
    })
    await alice.send({ type: 'ticket.approve', ticketId: ticket.id })
    await alice.send({
      type: 'contract.committed',
      branch: 'ss/ticket-leave/contract',
      commitSha: 'abc1234',
      prNumber: null,
    })
    const claimed = await alice.send({ type: 'task.claim', taskId: null })
    assert.ok(claimed.task)

    const error = await expectError(
      alice.send({ type: 'ticket.leave', ticketId: ticket.id }),
      'conflict',
    )
    assert.match(error.message, /Release or finish it/)
  })
})

describe('what it cost and who is still here', () => {
  const open = (client, title, body = '') => client.send({ type: 'ticket.create', title, body })

  it('bills tokens to the ticket whose task the person is holding', async () => {
    const { alice, bob, aliceId } = await twoDevSession('usage-ticket')
    const { ticket } = await open(alice, 'Add due dates')
    await bob.send({ type: 'ticket.join', ticketId: ticket.id })
    await alice.send({
      type: 'decomposition.propose',
      contract,
      tasks,
      participantCount: 2,
      issueRef: null,
      ticketId: ticket.id,
    })
    await alice.send({ type: 'ticket.approve', ticketId: ticket.id })
    await alice.send({
      type: 'contract.committed',
      branch: 'ss/usage-ticket/contract',
      commitSha: 'abc1234',
      prNumber: null,
    })
    await alice.send({ type: 'task.claim', taskId: 'theme-toggle' })

    await alice.send({
      type: 'usage.report',
      inputTokens: 1200,
      outputTokens: 800,
      cacheReadTokens: 40_000,
      cacheCreationTokens: 500,
      turns: 3,
    })
    await settle()

    const recorded = alice.eventsOfType('usage.recorded').at(-1)
    assert.equal(recorded.body.participantId, aliceId)
    assert.equal(
      recorded.body.ticketId,
      ticket.id,
      'cost lands on the ticket that caused it, not in one pile',
    )

    // A second report accumulates rather than replacing.
    await alice.send({
      type: 'usage.report',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      turns: 1,
    })
    await settle()

    const snapshot = await alice.send({
      type: 'session.join',
      sessionRef: 'usage-ticket',
      githubLogin: 'alice',
      displayName: 'Alice',
      repoPath: '/tmp/alice/web',
      fromSeq: null,
    })
    const mine = snapshot.snapshot.usage.find((u) => u.participantId === aliceId)
    assert.equal(mine.outputTokens, 850)
    assert.equal(mine.turns, 4)
  })

  it('records work done outside any ticket against nothing in particular', async () => {
    const { alice } = await twoDevSession('usage-loose')
    await alice.send({
      type: 'usage.report',
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      turns: 1,
    })
    await settle()
    assert.equal(alice.eventsOfType('usage.recorded').at(-1).body.ticketId, null)
  })

  it('ignores an empty report rather than logging noise', async () => {
    const { alice } = await twoDevSession('usage-empty')
    await alice.send({
      type: 'usage.report',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      turns: 0,
    })
    await settle()
    assert.equal(alice.eventsOfType('usage.recorded').length, 0)
  })

  /**
   * Presence used to be a flag flipped by a websocket, so anyone who only ever
   * spoke over HTTP -- every attached checkout -- stayed "connected" forever and
   * sessions filled up with people who had walked away.
   */
  it('stops calling someone present when they have not been heard from', async () => {
    const { alice, aliceId, bobId } = await twoDevSession('presence')
    const sessionId = app.store.findSessionIdByRef('presence')

    const now = app.service.snapshotOf(sessionId)
    assert.equal(now.participants.every((p) => p.connected), true, 'both just spoke')

    // Bob's last word was a while ago; Alice is mid-conversation.
    app.service.seen(aliceId)
    app.service.lastSeen.set(bobId, Date.now() - 60 * 60 * 1000)

    const later = app.service.snapshotOf(sessionId)
    assert.equal(later.participants.find((p) => p.id === aliceId).connected, true)
    assert.equal(later.participants.find((p) => p.id === bobId).connected, false)
    await alice.send({ type: 'session.sync', fromSeq: 0 })
  })
})
