import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { ClientCommand } from '@session-share/protocol'
import { createApp } from '../dist/index.js'

/**
 * The state machine, driven in-process. These are the transitions an audit
 * found could be taken from the wrong state -- each one walked the board into
 * something the log would happily replay and nobody could get out of.
 */

const REPO = { owner: 'acme', name: 'web', baseBranch: 'main', remoteUrl: 'x' }

const contract = (path, contents = '') => ({
  summary: 'seam',
  files: [{ path, purpose: 'shared', contents }],
})

const spec = (id, ownedPaths, dependsOn = []) => ({
  id,
  title: id,
  intent: id,
  ownedPaths,
  dependsOn,
  assumes: [],
  acceptance: { testCommand: 'npm test', testFiles: ['x.test.ts'], manualChecks: [] },
  estimateMinutes: 30,
})

const apps = []
const dirs = []
after(async () => {
  for (const app of apps) await app.close()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function session(dbPath = ':memory:') {
  const app = createApp({ dbPath })
  apps.push(app)
  const run = (ctx, command) => app.service.handle(ClientCommand.parse(command), ctx)
  const { sessionId } = run(
    { sessionId: null, participantId: null },
    { type: 'session.create', slug: 'sm', title: 'State machine', repo: REPO },
  )
  const join = (login) => {
    const user = { id: login, githubLogin: login, displayName: login, avatarUrl: null }
    const ctx = { sessionId: null, participantId: null, user }
    run(ctx, { type: 'session.join', sessionRef: 'sm', repoPath: `/tmp/${login}`, fromSeq: 0 })
    return ctx
  }
  const fails = (ctx, command, code) => {
    assert.throws(() => run(ctx, command), (error) => error.code === code, `expected ${code}`)
  }
  return { app, run, join, fails, sessionId, state: () => app.service.state(sessionId) }
}

/** Two people on one ticket, its split proposed and checked. */
function ticketWithSplit(s, a, b, title, contractPath, tasks) {
  const { ticket } = s.run(a, { type: 'ticket.create', title })
  s.run(b, { type: 'ticket.join', ticketId: ticket.id })
  const proposal = s.run(a, {
    type: 'decomposition.propose',
    contract: contract(contractPath),
    tasks,
    participantCount: 2,
    ticketId: ticket.id,
  })
  return { ticket, proposal }
}

/** A ticket started and its contract landed, ready to claim. */
function liveTicket(s, a, b, title, contractPath, tasks) {
  const made = ticketWithSplit(s, a, b, title, contractPath, tasks)
  assert.equal(made.proposal.validation.ok, true, JSON.stringify(made.proposal.validation.issues))
  s.run(a, { type: 'ticket.approve', ticketId: made.ticket.id })
  s.run(a, { type: 'contract.committed', branch: 'ss/sm/contract', commitSha: 'abc', ticketId: made.ticket.id })
  return made
}

describe('rebuilding after a restart', () => {
  it('folds the whole log, not just its first page', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ss-rebuild-'))
    dirs.push(dir)
    const dbPath = join(dir, 'events.db')
    const s = session(dbPath)
    const a = s.join('alice')
    for (let i = 0; i < 5100; i++) {
      s.run(a, { type: 'activity.report', activity: { state: 'working', detail: `${i}`, taskId: null } })
    }
    s.run(a, { type: 'chat.post', body: 'last words' })

    const restarted = createApp({ dbPath })
    apps.push(restarted)
    const rebuilt = restarted.service.state(s.sessionId)
    assert.equal(rebuilt.seq, s.state().seq)
    assert.equal(rebuilt.chat.at(-1)?.body, 'last words')
  })
})

describe('one split per ticket', () => {
  it('starts each ticket from its own split, whichever was proposed last', () => {
    const s = session()
    const a = s.join('alice')
    const b = s.join('bob')
    const A = ticketWithSplit(s, a, b, 'A', 'src/a/c.ts', [spec('a-one', ['src/a/x/**'])])
    const B = ticketWithSplit(s, a, b, 'B', 'src/b/c.ts', [spec('b-one', ['src/b/x/**'])])

    s.run(a, { type: 'ticket.approve', ticketId: A.ticket.id })
    const seeded = [...s.state().tasks.values()]
    assert.deepEqual(seeded.map((t) => t.id), ['a-one'], "starting A must not seed B's split")
    assert.equal(seeded[0].ticketId, A.ticket.id)

    const snapshot = s.app.service.snapshotOf(s.sessionId)
    assert.ok(snapshot.decompositions[A.proposal.decompositionId])
    assert.ok(snapshot.decompositions[B.proposal.decompositionId])
    assert.equal(snapshot.decomposition.id, A.proposal.decompositionId, 'the split waiting to land comes first')
  })

  it('keeps a ticket unclaimable until its own contract lands', () => {
    const s = session()
    const a = s.join('alice')
    const b = s.join('bob')
    liveTicket(s, a, b, 'A', 'src/a/c.ts', [spec('a-one', ['src/a/x/**'])])
    const B = ticketWithSplit(s, a, b, 'B', 'src/b/c.ts', [spec('b-one', ['src/b/x/**'])])
    s.run(b, { type: 'ticket.approve', ticketId: B.ticket.id })

    s.fails(b, { type: 'task.claim', taskId: 'b-one' }, 'not_ready')
    assert.equal(s.run(a, { type: 'task.claim', taskId: 'a-one' }).task.id, 'a-one')

    // Named by nobody: the split the snapshot offers as waiting to land.
    s.run(b, { type: 'contract.committed', branch: 'ss/sm/contract', commitSha: 'def' })
    assert.equal(s.run(b, { type: 'task.claim', taskId: 'b-one' }).task.id, 'b-one')
  })

  it('freezes every landed contract, not just the newest', () => {
    const s = session()
    const a = s.join('alice')
    const b = s.join('bob')
    liveTicket(s, a, b, 'A', 'src/a/c.ts', [spec('a-one', ['src/a/x/**'])])
    liveTicket(s, a, b, 'B', 'src/b/c.ts', [spec('b-one', ['src/b/x/**'])])
    const check = s.run(a, { type: 'lease.check', paths: ['src/a/c.ts', 'SRC/B/C.ts'] })
    assert.deepEqual(check.denials.map((d) => d.path), ['src/a/c.ts', 'SRC/B/C.ts'])
  })

  it('refuses a new split for a ticket already being built', () => {
    const s = session()
    const a = s.join('alice')
    const b = s.join('bob')
    const A = liveTicket(s, a, b, 'A', 'src/a/c.ts', [spec('a-one', ['src/a/x/**'])])
    s.fails(
      a,
      { type: 'decomposition.propose', contract: contract('src/a/d.ts'), tasks: [spec('a-two', ['src/a/y/**'])], participantCount: 2, ticketId: A.ticket.id },
      'conflict',
    )
  })
})

describe('task ids', () => {
  it('refuses an id another ticket is already using', () => {
    const s = session()
    const a = s.join('alice')
    const b = s.join('bob')
    liveTicket(s, a, b, 'A', 'src/a/c.ts', [spec('shared-id', ['src/a/x/**'])])
    const { proposal } = ticketWithSplit(s, a, b, 'B', 'src/b/c.ts', [spec('shared-id', ['docs/**'])])
    assert.equal(proposal.validation.ok, false)
    assert.ok(proposal.validation.issues.some((i) => i.code === 'task_id_taken'))
  })

  it('refuses an id a split waiting to be started is using', () => {
    const s = session()
    const a = s.join('alice')
    const b = s.join('bob')
    ticketWithSplit(s, a, b, 'A', 'src/a/c.ts', [spec('shared-id', ['src/a/x/**'])])
    const { proposal } = ticketWithSplit(s, a, b, 'B', 'src/b/c.ts', [spec('shared-id', ['docs/**'])])
    assert.ok(proposal.validation.issues.some((i) => i.code === 'task_id_taken'))
  })

  it('refuses two tasks with one id in a single proposal', () => {
    const s = session()
    const a = s.join('alice')
    const b = s.join('bob')
    const { proposal } = ticketWithSplit(s, a, b, 'A', 'src/a/c.ts', [
      spec('twice', ['src/a/x/**']),
      spec('twice', ['src/a/y/**']),
    ])
    assert.ok(proposal.validation.issues.some((i) => i.code === 'duplicate_task_id'))
  })
})

describe('a split that failed validation', () => {
  it('cannot be started, and asking again re-asks for a split', () => {
    const s = session()
    const a = s.join('alice')
    const b = s.join('bob')
    const { ticket, proposal } = ticketWithSplit(s, a, b, 'A', 'src/a/c.ts', [
      spec('one', ['src/**']),
      spec('two', ['src/lib/**']),
    ])
    assert.equal(proposal.validation.ok, false)
    assert.equal(s.state().tickets.get(ticket.id).decompositionId, null)
    assert.equal(s.state().ticketStateFor(ticket.id), 'splitting')

    s.fails(b, { type: 'ticket.approve', ticketId: ticket.id }, 'not_ready')
    assert.equal(s.state().tasks.size, 0)
    assert.ok(s.run(a, { type: 'ticket.start', ticketId: ticket.id }).plannerId, 'start asks for a new split')
  })
})

describe('reporting on the assembled thing', () => {
  it('refuses a verdict while tasks are still being built', () => {
    const s = session()
    const a = s.join('alice')
    const b = s.join('bob')
    const { ticket } = liveTicket(s, a, b, 'A', 'src/a/c.ts', [spec('one', ['src/a/x/**']), spec('two', ['src/a/y/**'])])
    s.run(a, { type: 'task.claim', taskId: 'one' })

    s.fails(b, { type: 'ticket.verified', ticketId: ticket.id, passed: false, how: 'h', summary: 's' }, 'not_ready')
    s.fails(b, { type: 'ticket.verified', ticketId: ticket.id, passed: true, how: 'h', summary: 's' }, 'not_ready')
    assert.equal(s.state().tasks.get('one').ownerId, a.participantId, 'the held task is left alone')
    assert.ok(s.state().leases.get('one'))
  })

  it('refuses a failure that names only tasks it does not have', () => {
    const s = session()
    const a = s.join('alice')
    const b = s.join('bob')
    const { ticket } = liveTicket(s, a, b, 'A', 'src/a/c.ts', [spec('one', ['src/a/x/**'])])
    s.run(a, { type: 'task.claim', taskId: 'one' })
    s.run(a, { type: 'task.merged', taskId: 'one' })
    assert.equal(s.state().ticketStateFor(ticket.id), 'verify')

    assert.throws(
      () => s.run(b, { type: 'ticket.verified', ticketId: ticket.id, passed: false, how: 'h', summary: 's', broke: ['typo'] }),
      (error) => error.code === 'bad_request' && /typo/.test(error.message),
    )
    assert.equal(s.state().tasks.get('one').state, 'merged')
  })

  it('records a pull request only once the run has passed', () => {
    const s = session()
    const a = s.join('alice')
    const b = s.join('bob')
    const { ticket } = liveTicket(s, a, b, 'A', 'src/a/c.ts', [spec('one', ['src/a/x/**'])])
    s.fails(a, { type: 'ticket.shipped', ticketId: ticket.id, prNumber: 7 }, 'not_ready')

    s.run(a, { type: 'task.claim', taskId: 'one' })
    s.run(a, { type: 'task.merged', taskId: 'one' })
    s.fails(a, { type: 'ticket.shipped', ticketId: ticket.id, prNumber: 7 }, 'not_ready')
    s.run(b, { type: 'ticket.verified', ticketId: ticket.id, passed: true, how: 'h', summary: 's' })
    assert.equal(s.run(a, { type: 'ticket.shipped', ticketId: ticket.id, prNumber: 7 }).ticket.prNumber, 7)
  })
})

describe('progress', () => {
  it('cannot move a task to merged, or anywhere outside the working states', () => {
    const s = session()
    const a = s.join('alice')
    const b = s.join('bob')
    liveTicket(s, a, b, 'A', 'src/a/c.ts', [spec('one', ['src/a/x/**'])])
    s.run(a, { type: 'task.claim', taskId: 'one' })
    for (const state of ['merged', 'ready', 'blocked', 'pr', 'failed']) {
      s.fails(a, { type: 'task.progress', taskId: 'one', state, activityLine: 'x' }, 'bad_request')
    }
    s.run(a, { type: 'task.progress', taskId: 'one', state: 'running', activityLine: 'x' })
    assert.equal(s.state().tasks.get('one').state, 'running')
    assert.ok(s.state().leases.get('one'))
  })
})

describe('handoffs', () => {
  function granted() {
    const s = session()
    const a = s.join('alice')
    const b = s.join('bob')
    liveTicket(s, a, b, 'A', 'src/a/c.ts', [spec('one', ['src/a/x/**']), spec('two', ['src/a/y/**'])])
    s.run(a, { type: 'task.claim', taskId: 'one' })
    s.run(b, { type: 'task.claim', taskId: 'two' })
    const { request } = s.run(b, { type: 'handoff.request', path: 'src/a/x/f.ts' })
    s.run(a, { type: 'handoff.resolve', requestId: request.id, granted: true })
    assert.equal(s.run(b, { type: 'lease.check', paths: ['src/a/x/f.ts'] }).allowed, true)
    return { s, a, b, request }
  }

  it('ends when the granting task lands', () => {
    const { s, a, request } = granted()
    s.run(a, { type: 'task.merged', taskId: 'one' })
    assert.equal(s.state().handoffs.get(request.id).status, 'expired')
  })

  it('ends when the requester lets go of their own task', () => {
    const { s, b, request } = granted()
    s.run(b, { type: 'task.release', taskId: 'two' })
    assert.equal(s.state().handoffs.get(request.id).status, 'expired')
    assert.equal(s.run(b, { type: 'lease.check', paths: ['src/a/x/f.ts'] }).allowed, false)
  })

  it('needs a task of your own to ask for', () => {
    const s = session()
    const a = s.join('alice')
    const b = s.join('bob')
    liveTicket(s, a, b, 'A', 'src/a/c.ts', [spec('one', ['src/a/x/**'])])
    s.run(a, { type: 'task.claim', taskId: 'one' })
    s.fails(b, { type: 'handoff.request', path: 'src/a/x/f.ts' }, 'not_ready')
  })
})

describe('someone who has gone', () => {
  const HOUR = 60 * 60 * 1000

  it('can have their task taken back, but only once they have been away a while', () => {
    const s = session()
    const a = s.join('alice')
    const b = s.join('bob')
    liveTicket(s, a, b, 'A', 'src/a/c.ts', [spec('one', ['src/a/x/**'])])
    s.run(a, { type: 'task.claim', taskId: 'one' })

    s.fails(b, { type: 'task.forceRelease', taskId: 'one' }, 'conflict')

    s.app.service.lastSeen.set(a.participantId, Date.now() - HOUR)
    const result = s.run(b, { type: 'task.forceRelease', taskId: 'one' })
    assert.equal(result.holderId, a.participantId)
    assert.equal(s.state().tasks.get('one').state, 'ready')
    assert.equal(s.state().leases.has('one'), false)
    assert.equal(s.run(b, { type: 'task.claim', taskId: 'one' }).task.id, 'one')
  })

  it('is not open to someone outside the ticket while the lead is here', () => {
    const s = session()
    const a = s.join('alice') // lead
    const b = s.join('bob')
    const c = s.join('carol')
    liveTicket(s, a, b, 'A', 'src/a/c.ts', [spec('one', ['src/a/x/**'])])
    s.run(b, { type: 'task.claim', taskId: 'one' })
    s.app.service.lastSeen.set(b.participantId, Date.now() - HOUR)
    s.fails(c, { type: 'task.forceRelease', taskId: 'one' }, 'forbidden')
  })

  it('hands the lead on when the lead has gone', () => {
    const s = session()
    const a = s.join('alice') // lead
    const b = s.join('bob')
    const c = s.join('carol')
    liveTicket(s, a, b, 'A', 'src/a/c.ts', [spec('one', ['src/a/x/**'])])
    s.run(a, { type: 'task.claim', taskId: 'one' })
    s.app.service.lastSeen.set(a.participantId, Date.now() - HOUR)

    s.run(c, { type: 'task.forceRelease', taskId: 'one' })
    assert.equal(s.state().session.leadId, c.participantId)
  })
})

describe('splits that collide with another ticket', () => {
  it('catches a contract file inside another ticket running task', () => {
    const s = session()
    const a = s.join('alice')
    const b = s.join('bob')
    liveTicket(s, a, b, 'A', 'src/a/c.ts', [spec('a-one', ['src/shared/**'])])
    const { proposal } = ticketWithSplit(s, a, b, 'B', 'src/shared/types.ts', [spec('b-one', ['src/b/**'])])
    assert.equal(proposal.validation.ok, false)
    assert.ok(proposal.validation.issues.some((i) => i.code === 'overlaps_other_ticket' && /contract writes/.test(i.message)))
  })

  it('catches a task owning another ticket contract file', () => {
    const s = session()
    const a = s.join('alice')
    const b = s.join('bob')
    liveTicket(s, a, b, 'A', 'src/shared/types.ts', [spec('a-one', ['src/a/**'])])
    const { proposal } = ticketWithSplit(s, a, b, 'B', 'src/b/c.ts', [spec('b-one', ['src/shared/**'])])
    assert.ok(proposal.validation.issues.some((i) => i.code === 'overlaps_other_ticket' && /contract file/.test(i.message)))
  })

  it('catches two proposals that have not been started yet', () => {
    const s = session()
    const a = s.join('alice')
    const b = s.join('bob')
    ticketWithSplit(s, a, b, 'A', 'src/a/c.ts', [spec('a-one', ['src/x/**'])])
    const { proposal } = ticketWithSplit(s, a, b, 'B', 'src/b/c.ts', [spec('b-one', ['src/X/y.ts'])])
    assert.ok(proposal.validation.issues.some((i) => i.code === 'overlaps_other_ticket' && /proposed to own/.test(i.message)))
  })
})

/**
 * A command is one transaction. Claiming writes the lease and the task's new
 * state as separate events; a failure between them used to leave a lease with
 * no holder behind it, in the log, forever.
 */
describe('a command that fails halfway', () => {
  it('leaves neither the log nor the board believing half of it', () => {
    const s = session()
    const a = s.join('ann')
    const b = s.join('ben')
    liveTicket(s, a, b, 'Atomic', 'src/atomic/types.ts', [spec('atomic-one', ['src/atomic/one/**'])])
    const before = s.app.store.maxSeq(s.sessionId)

    const append = s.app.store.append.bind(s.app.store)
    let calls = 0
    s.app.store.append = (...args) => {
      if (++calls === 2) throw new Error('disk full')
      return append(...args)
    }
    assert.throws(() => s.run(a, { type: 'task.claim', taskId: 'atomic-one' }), /disk full/)
    s.app.store.append = append

    assert.equal(s.app.store.maxSeq(s.sessionId), before, 'nothing of it reached the log')
    assert.equal(s.state().leases.size, 0, 'and the live state was folded again from the log')
    assert.equal(s.state().tasks.get('atomic-one').ownerId, null)

    s.run(a, { type: 'task.claim', taskId: 'atomic-one' })
    assert.equal(s.state().tasks.get('atomic-one').ownerId !== null, true, 'and it can be claimed after all')
  })
})

describe('presence on an open board', () => {
  it('names only the people heard from lately', () => {
    const s = session()
    const a = s.join('ann')
    s.join('ben')
    const ben = [...s.state().participants.values()].find((p) => p.githubLogin === 'ben')
    s.app.service.lastSeen.set(ben.id, Date.now() - 60 * 60 * 1000)
    const present = s.app.service.presentIn(s.sessionId)
    assert.equal(present.includes(ben.id), false)
    assert.equal(present.length, 1)
    assert.ok(a)
  })

  it('carries only the recent room in a snapshot', () => {
    const s = session()
    const a = s.join('ann')
    for (let i = 0; i < 520; i++) s.run(a, { type: 'chat.post', body: `m${i}`, taskRef: null, asAgent: false })
    const chat = s.app.service.snapshotOf(s.sessionId).chat
    assert.equal(chat.length, 500)
    assert.equal(chat.at(-1).body, 'm519')
  })
})
