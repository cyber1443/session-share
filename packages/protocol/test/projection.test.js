import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { SessionState } from '../dist/index.js'

const SESSION = {
  id: 's1',
  slug: 'dark-mode',
  title: 'Dark mode',
  repo: { owner: 'acme', name: 'web', baseBranch: 'main', remoteUrl: 'git@github.com:acme/web.git' },
  issueRef: null,
  phase: 'build',
  leadId: 'p1',
  contractBranch: 'ss/dark-mode/contract',
  createdAt: 0,
}

const envelope = (seq, body) => ({ seq, sessionId: 's1', actorId: 'p1', ts: seq, body })

const chat = (id, body) =>
  envelope(id, {
    type: 'chat.message',
    message: {
      id: `m${id}`,
      sessionId: 's1',
      authorId: 'p1',
      authorKind: 'human',
      body,
      taskRef: null,
      mentions: [],
      createdAt: id,
    },
  })

describe('SessionState.apply', () => {
  it('ignores an event it has already applied', () => {
    const state = new SessionState()
    state.apply(envelope(0, { type: 'session.created', session: SESSION }))
    state.apply(chat(1, 'hello'))
    state.apply(chat(1, 'hello'))

    assert.equal(state.chat.length, 1, 'a redelivered event must not append twice')
    assert.equal(state.seq, 1)
  })

  it('ignores a stale event arriving after a newer one', () => {
    const state = new SessionState()
    state.apply(envelope(0, { type: 'session.created', session: SESSION }))
    state.apply(chat(2, 'second'))
    state.apply(chat(1, 'first'))

    assert.deepEqual(
      state.chat.map((m) => m.body),
      ['second'],
    )
    assert.equal(state.seq, 2)
  })

  it('applies a fresh event normally', () => {
    const state = new SessionState()
    state.apply(envelope(0, { type: 'session.created', session: SESSION }))
    state.apply(chat(1, 'one'))
    state.apply(chat(2, 'two'))
    assert.equal(state.chat.length, 2)
  })
})

describe('SessionState.hydrate', () => {
  it('adopts a snapshot and keeps applying from its seq', () => {
    const state = new SessionState()
    state.hydrate({
      session: SESSION,
      participants: [],
      decomposition: null,
      validation: null,
      tasks: [],
      leases: [],
      handoffs: [],
      chat: [],
      mergeQueue: [],
      seq: 10,
    })

    state.apply(chat(5, 'stale'))
    assert.equal(state.chat.length, 0, 'events older than the snapshot are already in it')

    state.apply(chat(11, 'new'))
    assert.equal(state.chat.length, 1)
  })

  it('replaces prior state rather than merging into it', () => {
    const state = new SessionState()
    state.apply(envelope(0, { type: 'session.created', session: SESSION }))
    state.apply(chat(1, 'old world'))

    state.hydrate({
      session: { ...SESSION, title: 'Different' },
      participants: [],
      decomposition: null,
      validation: null,
      tasks: [],
      leases: [],
      handoffs: [],
      chat: [],
      mergeQueue: [],
      seq: 3,
    })

    assert.equal(state.chat.length, 0)
    assert.equal(state.session.title, 'Different')
  })
})

const TICKET = {
  id: 't1',
  sessionId: 's1',
  title: 'Trello style board',
  body: '',
  authorId: 'p1',
  members: ['p1'],
  state: 'plan',
  decompositionId: null,
  verification: null,
  prNumber: null,
  createdAt: 0,
}

/**
 * The phase used to be latched by events and had no way back, so one finished
 * ticket left the session in `integrate` and every later split was refused.
 */
describe('SessionState.phaseNow', () => {
  const seeded = () => {
    const state = new SessionState()
    state.apply(envelope(0, { type: 'session.created', session: { ...SESSION, phase: 'integrate' } }))
    return state
  }

  it('ignores a phase the log latched, and answers from the tickets', () => {
    const state = seeded()
    state.apply(envelope(1, { type: 'ticket.created', ticket: TICKET }))
    assert.equal(state.phaseNow(), 'plan')
    assert.equal(state.snapshot().session.phase, 'plan')
  })

  it('comes back to plan when a new ticket opens after one has shipped', () => {
    const state = seeded()
    state.apply(envelope(1, { type: 'ticket.created', ticket: TICKET }))
    state.apply(envelope(2, { type: 'ticket.shipped', ticketId: 't1', prNumber: 7 }))
    assert.equal(state.phaseNow(), 'integrate')

    state.apply(envelope(3, { type: 'ticket.created', ticket: { ...TICKET, id: 't2' } }))
    assert.equal(state.phaseNow(), 'plan')
  })

  it('falls back to the tasks for a session that predates tickets', () => {
    const state = new SessionState()
    state.apply(envelope(0, { type: 'session.created', session: { ...SESSION, phase: 'plan' } }))
    assert.equal(state.phaseNow(), 'plan')
  })
})

describe('SessionState on a deleted ticket', () => {
  const TASK = {
    id: 'theme-toggle',
    sessionId: 's1',
    ticketId: 't1',
    title: 'Theme toggle',
    intent: 'flip it',
    ownedPaths: ['src/components/theme-toggle/**'],
    dependsOn: [],
    assumes: [],
    acceptance: { testCommand: 'npm test', testFiles: [], manualChecks: [] },
    estimateMinutes: 30,
    state: 'claimed',
    assigneeId: 'p1',
    ownerId: 'p1',
    branch: null,
    prNumber: null,
    lastTest: null,
    activityLine: null,
    depth: 0,
  }

  /** Replaying the log has to reach the same place the server did. */
  it('takes the tasks and leases with it', () => {
    const state = new SessionState()
    state.apply(envelope(0, { type: 'session.created', session: SESSION }))
    state.apply(envelope(1, { type: 'ticket.created', ticket: TICKET }))
    state.apply(envelope(2, { type: 'tasks.seeded', tasks: [TASK] }))
    state.apply(
      envelope(3, {
        type: 'lease.granted',
        lease: {
          taskId: 'theme-toggle',
          holderId: 'p1',
          paths: ['src/components/theme-toggle/**'],
          grantedAt: 3,
        },
      }),
    )
    assert.equal(state.tasks.size, 1)

    state.apply(envelope(4, { type: 'ticket.deleted', ticketId: 't1' }))
    assert.equal(state.tickets.size, 0)
    assert.equal(state.tasks.size, 0, 'an orphan task stays claimable forever')
    assert.equal(state.leases.size, 0, 'and its lease goes on denying edits')
  })

  it('leaves another ticket alone', () => {
    const state = new SessionState()
    state.apply(envelope(0, { type: 'session.created', session: SESSION }))
    state.apply(envelope(1, { type: 'ticket.created', ticket: TICKET }))
    state.apply(envelope(2, { type: 'ticket.created', ticket: { ...TICKET, id: 't2' } }))
    state.apply(
      envelope(3, { type: 'tasks.seeded', tasks: [TASK, { ...TASK, id: 'other', ticketId: 't2' }] }),
    )

    state.apply(envelope(4, { type: 'ticket.deleted', ticketId: 't1' }))
    assert.deepEqual([...state.tasks.keys()], ['other'])
  })
})

/**
 * The stored state is only an echo of what the work says. An echo can lag, and
 * a card in Splitting with a claimed task under it is the board lying about the
 * one thing it exists to show.
 */
describe('SessionState.snapshot', () => {
  it('serves each ticket in the state its work puts it in', () => {
    const state = new SessionState()
    state.apply(envelope(0, { type: 'session.created', session: SESSION }))
    state.apply(envelope(1, { type: 'ticket.created', ticket: { ...TICKET, state: 'proposed' } }))
    state.apply(
      envelope(2, {
        type: 'tasks.seeded',
        tasks: [
          {
            id: 'a',
            sessionId: 's1',
            ticketId: 't1',
            title: 'A',
            intent: '',
            ownedPaths: ['src/a.ts'],
            dependsOn: [],
            assumes: [],
            acceptance: { testCommand: 'npm test', testFiles: [], manualChecks: [] },
            estimateMinutes: 10,
            state: 'claimed',
            assigneeId: null,
            ownerId: 'p1',
            branch: null,
            prNumber: null,
            lastTest: null,
            activityLine: null,
            depth: 0,
          },
        ],
      }),
    )

    assert.equal(state.tickets.get('t1').state, 'proposed', 'the stored field has not caught up')
    assert.equal(state.snapshot().tickets[0].state, 'building', 'what a client is told')
  })
})

const spec = (id, ownedPaths) => ({
  id,
  title: id,
  intent: id,
  ownedPaths,
  dependsOn: [],
  assumes: [],
  acceptance: { testCommand: 't', testFiles: ['x.test.ts'], manualChecks: [] },
  estimateMinutes: 30,
})

const split = (id, ticketId, contractPath, tasks) => ({
  id,
  sessionId: 's1',
  ticketId,
  issueRef: null,
  contract: { summary: id, files: [{ path: contractPath, purpose: 'p', contents: '' }] },
  tasks,
  participantCount: 1,
  proposedBy: 'p1',
  status: 'proposed',
  approvals: [],
  assignments: [],
  createdAt: 0,
})

const ok = { ok: true, issues: [], frontierByDepth: [1], maxFrontier: 1 }
const failed = { ...ok, ok: false }

const ticket = (id) => ({
  id,
  sessionId: 's1',
  title: id,
  body: '',
  authorId: 'p1',
  members: ['p1'],
  state: 'plan',
  verification: null,
  decompositionId: null,
  prNumber: null,
  createdAt: 0,
})

const seeded = (taskSpec, ticketId) => ({
  ...taskSpec,
  sessionId: 's1',
  ticketId,
  state: 'ready',
  assigneeId: null,
  ownerId: null,
  branch: null,
  prNumber: null,
  lastTest: null,
  activityLine: null,
  depth: 0,
})

describe('SessionState: one split per ticket', () => {
  it('keeps each ticket on its own split, whichever was proposed last', () => {
    const state = new SessionState()
    state.apply(envelope(0, { type: 'session.created', session: { ...SESSION, contractBranch: null } }))
    state.apply(envelope(1, { type: 'ticket.created', ticket: ticket('A') }))
    state.apply(envelope(2, { type: 'ticket.created', ticket: ticket('B') }))
    state.apply(envelope(3, { type: 'decomposition.proposed', decomposition: split('dA', 'A', 'src/a/c.ts', [spec('a1', ['src/a/x/**'])]), validation: ok }))
    state.apply(envelope(4, { type: 'decomposition.proposed', decomposition: split('dB', 'B', 'src/b/c.ts', [spec('b1', ['src/b/x/**'])]), validation: ok }))

    assert.equal(state.splitOfTicket('A').id, 'dA')
    assert.equal(state.splitOfTicket('B').id, 'dB')
    const snapshot = state.snapshot()
    assert.deepEqual(Object.keys(snapshot.decompositions).sort(), ['dA', 'dB'])
    assert.equal(snapshot.decomposition.id, 'dB', 'the single field is still the newest proposal')
  })

  it('does not make a failed proposal the ticket split', () => {
    const state = new SessionState()
    state.apply(envelope(0, { type: 'session.created', session: SESSION }))
    state.apply(envelope(1, { type: 'ticket.created', ticket: ticket('A') }))
    state.apply(envelope(2, { type: 'decomposition.proposed', decomposition: split('bad', 'A', 'src/a/c.ts', [spec('a1', ['src/**'])]), validation: failed }))
    assert.equal(state.tickets.get('A').decompositionId, null)
    assert.ok(state.decompositions.has('bad'), 'but it is kept, so the repair round can see it')
  })

  it('lands only the contract it names, and freezes every landed one', () => {
    const state = new SessionState()
    state.apply(envelope(0, { type: 'session.created', session: { ...SESSION, contractBranch: null } }))
    state.apply(envelope(1, { type: 'ticket.created', ticket: ticket('A') }))
    state.apply(envelope(2, { type: 'ticket.created', ticket: ticket('B') }))
    state.apply(envelope(3, { type: 'decomposition.proposed', decomposition: split('dA', 'A', 'src/a/c.ts', [spec('a1', ['src/a/x/**'])]), validation: ok }))
    state.apply(envelope(4, { type: 'decomposition.proposed', decomposition: split('dB', 'B', 'src/b/c.ts', [spec('b1', ['src/b/x/**'])]), validation: ok }))
    state.apply(envelope(5, { type: 'decomposition.approval', decompositionId: 'dA', participantId: 'p1', approvals: ['p1'], satisfied: true }))
    state.apply(envelope(6, { type: 'tasks.seeded', tasks: [seeded(spec('a1', ['src/a/x/**']), 'A')] }))
    state.apply(envelope(7, { type: 'decomposition.approval', decompositionId: 'dB', participantId: 'p1', approvals: ['p1'], satisfied: true }))
    state.apply(envelope(8, { type: 'tasks.seeded', tasks: [seeded(spec('b1', ['src/b/x/**']), 'B')] }))
    state.apply(envelope(9, { type: 'contract.committed', decompositionId: 'dA', branch: 'c', commitSha: 'x', prNumber: null }))

    assert.equal(state.contractLanded(state.tasks.get('a1')), true)
    assert.equal(state.contractLanded(state.tasks.get('b1')), false, "B's seam is not on the branch yet")
    assert.deepEqual(state.frozenContractPaths(), ['src/a/c.ts'])

    state.apply(envelope(10, { type: 'contract.committed', decompositionId: 'dB', branch: 'c', commitSha: 'y', prNumber: null }))
    assert.deepEqual(state.frozenContractPaths().sort(), ['src/a/c.ts', 'src/b/c.ts'])
  })

  it('folds a log written before splits were named', () => {
    const state = new SessionState()
    state.apply(envelope(0, { type: 'session.created', session: { ...SESSION, contractBranch: null } }))
    state.apply(envelope(1, { type: 'ticket.created', ticket: ticket('A') }))
    state.apply(envelope(2, { type: 'decomposition.proposed', decomposition: split('dA', 'A', 'src/a/c.ts', [spec('a1', ['src/a/x/**'])]), validation: ok }))
    // No decompositionId anywhere: these meant "the newest proposal".
    state.apply(envelope(3, { type: 'decomposition.assigned', assignments: [{ taskId: 'a1', participantId: 'p1', manual: false }] }))
    state.apply(envelope(4, { type: 'decomposition.approval', participantId: 'p1', approvals: ['p1'], satisfied: true }))
    state.apply(envelope(5, { type: 'tasks.seeded', tasks: [seeded(spec('a1', ['src/a/x/**']), 'A')] }))
    state.apply(envelope(6, { type: 'contract.committed', branch: 'c', commitSha: 'x', prNumber: null }))

    const dA = state.decompositions.get('dA')
    assert.equal(dA.status, 'approved')
    assert.equal(dA.assignments.length, 1)
    assert.equal(state.contractLanded(state.tasks.get('a1')), true)
    assert.equal(state.pickTaskFor('p1')?.id, 'a1')
  })

  it('expires a handoff when either lease goes', () => {
    const state = new SessionState()
    state.apply(envelope(0, { type: 'session.created', session: SESSION }))
    const request = (id, heldByTaskId, requesterTaskId) => ({
      id, sessionId: 's1', path: 'src/a/f.ts', requesterId: 'p2', holderId: 'p1',
      heldByTaskId, requesterTaskId, reason: '', status: 'pending', createdAt: 0,
    })
    state.apply(envelope(1, { type: 'handoff.requested', request: request('h1', 't1', 't2') }))
    state.apply(envelope(2, { type: 'handoff.resolved', requestId: 'h1', granted: true, resolvedBy: 'p1' }))
    state.apply(envelope(3, { type: 'handoff.requested', request: request('h2', 't3', 't4') }))
    state.apply(envelope(4, { type: 'lease.released', taskId: 't1', holderId: 'p1' }))
    state.apply(envelope(5, { type: 'lease.released', taskId: 't4', holderId: 'p2' }))
    assert.equal(state.handoffs.get('h1').status, 'expired')
    assert.equal(state.handoffs.get('h2').status, 'expired')
  })
})

describe('SessionState: a snapshot round trip', () => {
  /**
   * Hydrating a snapshot has to land where folding the log did. Deleting the
   * ticket with the newest proposal clears the latest split on a fold, and
   * hydrate used to guess it back as "whichever split is last in the map".
   */
  it('agrees with the fold on the latest split after its ticket is deleted', () => {
    const folded = new SessionState()
    folded.apply(envelope(0, { type: 'session.created', session: { ...SESSION, contractBranch: null } }))
    folded.apply(envelope(1, { type: 'ticket.created', ticket: ticket('A') }))
    folded.apply(envelope(2, { type: 'ticket.created', ticket: ticket('B') }))
    folded.apply(envelope(3, { type: 'decomposition.proposed', decomposition: split('dA', 'A', 'src/a/c.ts', [spec('a1', ['src/a/x/**'])]), validation: ok }))
    folded.apply(envelope(4, { type: 'decomposition.proposed', decomposition: split('dB', 'B', 'src/b/c.ts', [spec('b1', ['src/b/x/**'])]), validation: ok }))
    folded.apply(envelope(5, { type: 'ticket.deleted', ticketId: 'B' }))
    assert.equal(folded.latestDecompositionId, null)

    const snapshot = folded.snapshot()
    assert.equal(snapshot.latestDecompositionId, null)

    const hydrated = new SessionState()
    hydrated.hydrate(snapshot)
    assert.equal(hydrated.latestDecompositionId, folded.latestDecompositionId)
    assert.deepEqual(hydrated.snapshot(), snapshot)
  })

  it('still guesses from the splits for a snapshot that predates the field', () => {
    const folded = new SessionState()
    folded.apply(envelope(0, { type: 'session.created', session: { ...SESSION, contractBranch: null } }))
    folded.apply(envelope(1, { type: 'ticket.created', ticket: ticket('A') }))
    folded.apply(envelope(2, { type: 'decomposition.proposed', decomposition: split('dA', 'A', 'src/a/c.ts', [spec('a1', ['src/a/x/**'])]), validation: ok }))
    const { latestDecompositionId, ...old } = folded.snapshot()
    assert.equal(latestDecompositionId, 'dA')

    const hydrated = new SessionState()
    hydrated.hydrate(old)
    assert.equal(hydrated.latestDecompositionId, 'dA')
  })
})
