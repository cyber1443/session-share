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
