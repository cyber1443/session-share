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
