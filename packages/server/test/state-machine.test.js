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
/** The contract-branch commit a run is reported against. */
const HEAD = 'a'.repeat(40)
const MOVED = 'b'.repeat(40)

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
  const join = (login, repoPath = `/tmp/${login}`) => {
    const user = { id: login, githubLogin: login, displayName: login, avatarUrl: null }
    const ctx = { sessionId: null, participantId: null, user }
    run(ctx, { type: 'session.join', sessionRef: 'sm', repoPath, fromSeq: 0 })
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

/** A split with no ticket, which still goes through approval. */
function legacySplit(s, ctx) {
  return s.run(ctx, {
    type: 'decomposition.propose',
    contract: contract('src/a/c.ts'),
    tasks: [spec('one', ['src/a/x/**'])],
    participantCount: 2,
  })
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

    const seeded = [...s.state().tasks.values()]
    assert.deepEqual(seeded.map((t) => t.id).sort(), ['a-one', 'b-one'])
    assert.equal(s.state().tasks.get('a-one').ticketId, A.ticket.id, 'each task belongs to its own ticket')
    assert.equal(s.state().tasks.get('b-one').ticketId, B.ticket.id)

    const snapshot = s.app.service.snapshotOf(s.sessionId)
    assert.ok(snapshot.decompositions[A.proposal.decompositionId])
    assert.ok(snapshot.decompositions[B.proposal.decompositionId])
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
    s.run(b, { type: 'ticket.verified', ticketId: ticket.id, passed: true, how: 'h', summary: 's', commitSha: HEAD })
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

  it('catches a split reaching into files another ticket already owns', () => {
    const s = session()
    const a = s.join('alice')
    const b = s.join('bob')
    ticketWithSplit(s, a, b, 'A', 'src/a/c.ts', [spec('a-one', ['src/x/**'])])
    const { proposal } = ticketWithSplit(s, a, b, 'B', 'src/b/c.ts', [spec('b-one', ['src/X/y.ts'])])
    assert.ok(proposal.validation.issues.some((i) => i.code === 'overlaps_other_ticket'))
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

describe('autopilot heartbeats', () => {
  it('shows a seat whose Claude Code polled lately, and forgets it once it stops', () => {
    const s = session()
    const a = s.join('ann')
    s.join('ben')
    s.run(a, { type: 'agent.heartbeat', autopilot: 'full' })
    assert.deepEqual(s.app.service.snapshotOf(s.sessionId).autopilots, { [a.participantId]: 'full' })

    s.app.service.autopilots.set(a.participantId, { mode: 'full', at: Date.now() - 5 * 60 * 1000 })
    assert.deepEqual(s.app.service.autopilotsIn(s.sessionId), {})
  })

  it('refuses one from a board, which has no Claude Code behind it', () => {
    const s = session()
    const a = s.join('ann')
    s.fails({ ...a, via: 'board' }, { type: 'agent.heartbeat', autopilot: 'full' }, 'forbidden')
  })
})

describe('the lead', () => {
  const HOUR = 60 * 60 * 1000
  const quiet = (s, ctx) => s.app.service.lastSeen.set(ctx.participantId, Date.now() - HOUR)
  const leadEvents = (s) =>
    s.app.service.readEvents(s.sessionId, 0).filter((e) => e.body.type === 'session.lead')

  it('is not taken over by landing a task whose holder is still working', () => {
    const s = session()
    const a = s.join('alice') // lead
    const b = s.join('bob')
    const c = s.join('carol')
    liveTicket(s, a, b, 'A', 'src/a/c.ts', [spec('one', ['src/a/x/**'])])
    s.run(b, { type: 'task.claim', taskId: 'one' })
    quiet(s, a)

    s.fails(c, { type: 'task.merged', taskId: 'one', commitSha: 'zzz' }, 'forbidden')
    assert.equal(s.state().tasks.get('one').state, 'claimed')
    assert.equal(s.state().session.leadId, a.participantId, 'asking did not make carol the lead')
  })

  it('cannot land a task whose holder is still working, even while here', () => {
    const s = session()
    const a = s.join('alice') // lead
    const b = s.join('bob')
    liveTicket(s, a, b, 'A', 'src/a/c.ts', [spec('one', ['src/a/x/**'])])
    s.run(b, { type: 'task.claim', taskId: 'one' })
    s.fails(a, { type: 'task.merged', taskId: 'one', commitSha: 'zzz' }, 'forbidden')

    quiet(s, b)
    s.run(a, { type: 'task.merged', taskId: 'one', commitSha: 'zzz' })
    assert.equal(s.state().tasks.get('one').state, 'merged')
  })

  it('passes, as its own event, to whoever lands an abandoned task once the lead has gone', () => {
    const s = session()
    const a = s.join('alice') // lead
    const b = s.join('bob')
    const c = s.join('carol')
    liveTicket(s, a, b, 'A', 'src/a/c.ts', [spec('one', ['src/a/x/**'])])
    s.run(b, { type: 'task.claim', taskId: 'one' })
    quiet(s, a)
    quiet(s, b)
    const before = leadEvents(s).length

    s.run(c, { type: 'task.merged', taskId: 'one', commitSha: 'zzz' })
    assert.equal(s.state().session.leadId, c.participantId)
    assert.equal(leadEvents(s).length, before + 1)
  })

  it('does not move when a command fails', () => {
    const s = session()
    const a = s.join('alice')
    const b = s.join('bob')
    quiet(s, a)
    s.fails(b, { type: 'task.merged', taskId: 'nope', commitSha: 'x' }, 'not_found')
    s.fails(b, { type: 'decomposition.approve', decompositionId: '00000000-0000-0000-0000-000000000000' }, 'conflict')
    assert.equal(s.state().session.leadId, a.participantId)
  })

  it('does not move for an approval that needs everyone, not the lead', () => {
    const s = session()
    const a = s.join('alice')
    const b = s.join('bob')
    const c = s.join('carol')
    const proposal = legacySplit(s, a)
    quiet(s, a)
    s.run(b, { type: 'decomposition.approve', decompositionId: proposal.decompositionId })
    s.run(c, { type: 'decomposition.approve', decompositionId: proposal.decompositionId })
    assert.equal(s.state().session.leadId, a.participantId)
  })

  it('passes to an approver in a big room only once the lead has gone', () => {
    const s = session()
    const a = s.join('alice')
    const b = s.join('bob')
    s.join('carol')
    s.join('dave')
    s.join('erin')
    const proposal = legacySplit(s, a)

    const first = s.run(b, { type: 'decomposition.approve', decompositionId: proposal.decompositionId })
    assert.equal(first.satisfied, false, 'the lead is here, and it is her call')
    assert.equal(s.state().session.leadId, a.participantId)

    quiet(s, a)
    const second = s.run(b, { type: 'decomposition.approve', decompositionId: proposal.decompositionId })
    assert.equal(second.satisfied, true)
    assert.equal(s.state().session.leadId, b.participantId)
  })
})

describe('approval', () => {
  /** Legacy (ticketless) split, so nobody is required by ticket membership. */
  const propose = (s, ctx) =>
    s.run(ctx, {
      type: 'decomposition.propose',
      contract: contract('src/c.ts'),
      tasks: [spec('task-one', ['src/x/**'])],
      participantCount: 2,
    })

  it('counts a person once, however many checkouts they have', () => {
    const s = session()
    const a1 = s.join('alice', '/tmp/a1')
    const b = s.join('bob')
    s.join('alice', '/tmp/a2')
    assert.equal(s.state().participants.size, 3)

    const { decompositionId } = propose(s, a1)
    s.run(b, { type: 'decomposition.approve', decompositionId })
    const result = s.run(a1, { type: 'decomposition.approve', decompositionId })
    assert.equal(result.satisfied, true, 'alice and bob both approved')
  })

  it('does not let extra checkouts make a small room look big', () => {
    const s = session()
    const a1 = s.join('alice', '/tmp/a1')
    s.join('alice', '/tmp/a2')
    s.join('bob', '/tmp/b1')
    s.join('bob', '/tmp/b2')

    const { decompositionId } = propose(s, a1)
    const result = s.run(a1, { type: 'decomposition.approve', decompositionId })
    assert.equal(result.satisfied, false, 'two people, so bob has to agree too')
  })
})

describe('rejecting a split', () => {
  it('only turns down a proposal, never a split being built', () => {
    const s = session()
    const a = s.join('alice')
    const b = s.join('bob')
    const { proposal } = liveTicket(s, a, b, 'A', 'src/a/c.ts', [spec('one', ['src/a/x/**'])])
    s.fails(b, { type: 'decomposition.reject', decompositionId: proposal.decompositionId, reason: 'no' }, 'not_ready')
    assert.equal(s.state().decompositions.get(proposal.decompositionId).status, 'approved')
  })

  it('is for the people on the ticket, or the lead', () => {
    const s = session()
    const a = s.join('alice') // lead
    const b = s.join('bob')
    const c = s.join('carol')
    const { ticket } = s.run(b, { type: 'ticket.create', title: 'B' })
    // A valid ticket split starts at once; one the validator refused waits to be redone.
    const proposal = s.run(b, {
      type: 'decomposition.propose',
      contract: contract('src/b/c.ts'),
      tasks: [spec('one', ['../outside/**'])],
      participantCount: 1,
      ticketId: ticket.id,
    })
    assert.equal(proposal.validation.ok, false)
    s.fails(c, { type: 'decomposition.reject', decompositionId: proposal.decompositionId, reason: 'no' }, 'forbidden')
    s.run(a, { type: 'decomposition.reject', decompositionId: proposal.decompositionId, reason: 'redo' })
    assert.equal(s.state().decompositions.get(proposal.decompositionId).status, 'rejected')
  })
})

describe('presence that keeps a task', () => {
  const HOUR = 60 * 60 * 1000

  it('comes from the checkout, not from a board sitting in its seat', () => {
    const s = session()
    const a = s.join('alice')
    const b = s.join('bob')
    liveTicket(s, a, b, 'A', 'src/a/c.ts', [spec('one', ['src/a/x/**'])])
    s.run(a, { type: 'task.claim', taskId: 'one' })

    // The laptop shut an hour ago; the board tab on another screen kept pinging.
    s.app.service.lastWorked.set(a.participantId, Date.now() - HOUR)
    s.app.service.seen(a.participantId)
    s.run({ ...a, via: 'board' }, { type: 'chat.read' })
    assert.ok(s.app.service.presentIn(s.sessionId).includes(a.participantId), 'still in the room')

    const result = s.run(b, { type: 'task.forceRelease', taskId: 'one' })
    assert.equal(result.holderId, a.participantId)
  })

  it('is kept by the checkout speaking for itself', () => {
    const s = session()
    const a = s.join('alice')
    const b = s.join('bob')
    liveTicket(s, a, b, 'A', 'src/a/c.ts', [spec('one', ['src/a/x/**'])])
    s.run(a, { type: 'task.claim', taskId: 'one' })
    s.app.service.lastWorked.set(a.participantId, Date.now() - HOUR)
    s.run(a, { type: 'lease.check', paths: ['src/a/x/f.ts'] })
    s.fails(b, { type: 'task.forceRelease', taskId: 'one' }, 'conflict')
  })
})

describe('whose task an agent takes', () => {
  it('leaves a teammate their own task while their Claude Code is open, and takes it once they are gone', () => {
    const s = session()
    const a = s.join('alice')
    const b = s.join('bob')
    liveTicket(s, a, b, 'A', 'src/a/c.ts', [spec('mine', ['src/a/x/**']), spec('theirs', ['src/a/y/**'])])
    const tasks = s.state().tasks
    const aliceTask = [...tasks.values()].find((t) => t.assigneeId === a.participantId)
    const bobTask = [...tasks.values()].find((t) => t.assigneeId === b.participantId)
    s.run(a, { type: 'task.claim', taskId: aliceTask.id })
    s.run(a, { type: 'task.merged', taskId: aliceTask.id, commitSha: 'x' })

    s.run(b, { type: 'agent.heartbeat', autopilot: 'full' })
    const left = s.run(a, { type: 'task.claim' })
    assert.equal(left.task, null, 'bob is there to do his own')
    assert.match(left.reason, /leave it to them/)

    s.run(b, { type: 'agent.heartbeat', autopilot: 'full', limited: true })
    assert.equal(s.state().tasks.get(bobTask.id).assigneeId, a.participantId, 'out of usage: his task is handed on')
    assert.equal(s.run(a, { type: 'task.claim' }).task.id, bobTask.id)
  })
})

describe('a daily token limit', () => {
  it('hands work on once a person spends what they allowed themselves, and only their own profile', () => {
    const s = session()
    const a = s.join('alice')
    const b = s.join('bob')
    liveTicket(s, a, b, 'D', 'src/d/c.ts', [spec('d-mine', ['src/d/x/**']), spec('d-theirs', ['src/d/y/**'])])
    const bobTask = [...s.state().tasks.values()].find((t) => t.assigneeId === b.participantId)
    s.run(a, { type: 'agent.heartbeat', autopilot: 'full' })
    s.run(b, { type: 'agent.heartbeat', autopilot: 'full' })

    const set = s.run(b, { type: 'profile.update', dailyLimit: 1000 })
    assert.equal(set.profile.login, 'bob', 'the limit lands on the caller')

    const under = s.run(b, { type: 'usage.report', inputTokens: 100, outputTokens: 100 })
    assert.equal(under.overLimit, false)
    assert.equal(s.state().tasks.get(bobTask.id).assigneeId, b.participantId)

    const over = s.run(b, { type: 'usage.report', inputTokens: 0, outputTokens: 200 })
    assert.equal(over.overLimit, true, '100 + 100*5 + 200*5 units is past 1000')
    assert.equal(s.state().tasks.get(bobTask.id).assigneeId, a.participantId, 'his task is handed on')
    assert.ok(s.app.service.limitedIn(s.sessionId).includes(b.participantId))
    assert.equal(s.run(b, { type: 'agent.heartbeat', autopilot: 'full' }).overLimit, true)
    assert.match(s.run(b, { type: 'task.claim' }).reason, /daily token limit/)

    s.run(b, { type: 'profile.update', dailyLimit: null })
    assert.equal(s.app.service.limitedIn(s.sessionId).includes(b.participantId), false)
    assert.equal(s.state().profiles.has('alice'), false, "alice's profile is untouched")
  })
})

describe('what a verification run turns up', () => {
  it('files each follow-up as a linked ticket in plan, once', () => {
    const s = session()
    const a = s.join('alice')
    const b = s.join('bob')
    const { ticket } = liveTicket(s, a, b, 'Checkout', 'src/f/c.ts', [spec('f-one', ['src/f/x/**'])])
    const task = [...s.state().tasks.values()].find((t) => t.ticketId === ticket.id)
    const owner = task.assigneeId === a.participantId ? a : b
    s.run(owner, { type: 'task.claim', taskId: task.id })
    s.run(owner, { type: 'task.merged', taskId: task.id, commitSha: 'x' })

    const followUps = [
      { title: 'Coupon field ignores whitespace', body: 'Trailing space rejects valid codes.' },
      { title: 'Check tax rounding with finance' },
      { title: 'coupon field ignores whitespace' },
    ]
    const result = s.run(a, { type: 'ticket.verified', ticketId: ticket.id, passed: true, how: 'playwright', summary: 'ok', followUps, commitSha: HEAD })
    assert.equal(result.followUps.length, 2, 'the repeated title is filed once')
    const filed = s.state().tickets.get(result.followUps[0].id)
    assert.equal(filed.followUpOf, ticket.id)
    assert.equal(s.state().ticketStateFor(filed.id), 'plan', 'nothing starts it')
    assert.match(filed.body, /Found while verifying "Checkout"/)
  })
})

describe('daily summaries', () => {
  it('takes a digest, asks a checkout for the write-up, and keeps what it posts', () => {
    const s = session()
    const a = s.join('alice')
    s.join('bob')
    s.run(a, { type: 'ticket.create', title: 'Search page' })
    s.run(a, { type: 'usage.report', inputTokens: 10, outputTokens: 10 })

    const { summary } = s.run(a, { type: 'summary.request' })
    assert.equal(summary.writerId, a.participantId, 'no host machine here, so the lead writes it')
    assert.deepEqual(summary.digest.opened, ['Search page'])
    assert.equal(summary.digest.spend[0].login, 'alice')
    assert.ok(s.state().chat.some((m) => m.directive && m.mentions.includes(a.participantId) && /ss_summary/.test(m.body)))

    s.run(a, { type: 'summary.post', day: summary.day, narrative: '**Where we stand** search started.' })
    assert.match(s.state().summaries.get(summary.day).narrative, /search started/)
    s.fails(a, { type: 'summary.post', day: '2001-01-01', narrative: 'x' }, 'not_found')
  })

  it("prefers the host's own checkout as the writer", () => {
    const s = session()
    s.join('alice')
    const b = s.join('bob')
    const bob = s.state().participants.get(b.participantId)
    s.state().participants.set(bob.id, { ...bob, machineId: 'host-box' })
    s.app.service.hostMachineId = 'host-box'
    assert.equal(s.run(b, { type: 'summary.request' }).summary.writerId, b.participantId)
  })
})

describe('a ticket that asks for a human look', () => {
  function verifiable(s, a, b) {
    const made = liveTicket(s, a, b, 'Looks', 'src/l/c.ts', [spec('look-one', ['src/l/x/**'])])
    s.run(a, { type: 'ticket.needsHuman', ticketId: made.ticket.id, value: true })
    const task = [...s.state().tasks.values()][0]
    const owner = task.assigneeId === a.participantId ? a : b
    s.run(owner, { type: 'task.claim', taskId: task.id })
    s.run(owner, { type: 'task.merged', taskId: task.id, commitSha: 'x' })
    return made.ticket
  }

  it('waits in verify after the automated run passes, until someone tries it', () => {
    const s = session()
    const a = s.join('alice')
    const b = s.join('bob')
    const ticket = verifiable(s, a, b)
    s.run(a, { type: 'ticket.verified', ticketId: ticket.id, passed: true, how: 'playwright', summary: 'ok', commitSha: HEAD })
    assert.equal(s.state().ticketStateFor(ticket.id), 'verify', 'a passing run is not enough on its own')
    const shipNow = () => s.state().chat.filter((m) => m.directive && /ss_ship/.test(m.body)).length
    assert.equal(shipNow(), 0)

    s.run(b, { type: 'ticket.humanCheck', ticketId: ticket.id, passed: true, note: 'clicked through it' })
    assert.equal(s.state().ticketStateFor(ticket.id), 'review')
    assert.equal(shipNow(), 1, 'and only then is the PR asked for')
  })

  it('reopens the work when the person finds it broken', () => {
    const s = session()
    const a = s.join('alice')
    const b = s.join('bob')
    const ticket = verifiable(s, a, b)
    s.run(a, { type: 'ticket.verified', ticketId: ticket.id, passed: true, how: 'playwright', summary: 'ok', commitSha: HEAD })
    s.run(b, { type: 'ticket.humanCheck', ticketId: ticket.id, passed: false, note: 'the button does nothing' })
    assert.equal(s.state().ticketStateFor(ticket.id), 'building')
    assert.equal(s.state().tasks.get('look-one').state, 'ready')
    assert.match(s.state().tickets.get(ticket.id).verification.summary, /button does nothing/)
  })

  it("asks the caller's own checkout to start it for them", () => {
    const s = session()
    const a = s.join('alice')
    const b = s.join('bob')
    const ticket = verifiable(s, a, b)
    const asked = s.run(b, { type: 'ticket.runLocally', ticketId: ticket.id })
    assert.equal(asked.asked, b.participantId)
    const directive = s.state().chat.filter((m) => m.directive).at(-1)
    assert.deepEqual(directive.mentions, [b.participantId])
    assert.match(directive.body, /ss_worktree/)
  })
})

describe('a pass is about one commit', () => {
  /** A ticket whose tasks have all landed, waiting in verify. */
  function landed(s, a, b, ids = ['p-one', 'p-two']) {
    const made = liveTicket(s, a, b, 'Pay', 'src/p/c.ts', ids.map((id) => spec(id, [`src/p/${id}/**`])))
    for (const id of ids) {
      s.run(a, { type: 'task.claim', taskId: id })
      s.run(a, { type: 'task.merged', taskId: id })
    }
    assert.equal(s.state().ticketStateFor(made.ticket.id), 'verify')
    return made.ticket
  }
  const pass = (ticketId, commitSha = HEAD) => ({ type: 'ticket.verified', ticketId, passed: true, how: 'playwright', summary: 'ok', commitSha })
  const pull = (over = {}) => ({
    number: 7, open: true, headSha: HEAD, headRef: 'ss/sm/contract', headRepo: 'acme/web', baseRef: 'main', baseRepo: 'acme/web', ...over,
  })

  it('will not take a pass that does not say what it ran', () => {
    const s = session()
    const a = s.join('alice')
    const b = s.join('bob')
    const ticket = landed(s, a, b)
    s.fails(b, { ...pass(ticket.id), commitSha: undefined }, 'bad_request')
    assert.equal(s.state().ticketStateFor(ticket.id), 'verify')
  })

  it('goes back to verify, and cannot ship or merge, once its work changes after passing', () => {
    const s = session()
    const a = s.join('alice')
    const b = s.join('bob')
    const ticket = landed(s, a, b)
    s.run(b, pass(ticket.id))
    s.run(a, { type: 'ticket.shipped', ticketId: ticket.id, prNumber: 7 })
    assert.equal(s.app.service.mergeRefusal(s.sessionId, pull()), null, 'passed at exactly this head')

    // One of its tasks is reopened by its holder and lands again: new code, nobody ran it.
    s.run(a, { type: 'task.testResult', taskId: 'p-one', result: { passed: true, command: 'npm test', exitCode: 0, summary: 'ok', ranAt: Date.now() } })
    assert.equal(s.state().ticketStateFor(ticket.id), 'building', 'an open PR does not hide work being redone')
    s.run(a, { type: 'task.merged', taskId: 'p-one' })
    assert.equal(s.state().ticketStateFor(ticket.id), 'verify')
    assert.equal(s.state().tickets.get(ticket.id).verification.stale, true)
    assert.ok(s.state().chat.some((m) => m.directive && /not of what is on the branch now/.test(m.body)), 'and someone is asked to run it again')
    assert.match(s.app.service.mergeRefusal(s.sessionId, pull()), /changed after it passed/)
    s.fails(a, { type: 'ticket.shipped', ticketId: ticket.id, prNumber: 7 }, 'not_ready')

    s.run(b, pass(ticket.id, MOVED))
    assert.equal(s.state().ticketStateFor(ticket.id), 'review')
    assert.match(s.app.service.mergeRefusal(s.sessionId, pull()), /passed at bbbbbbb, not at this head/)
    assert.equal(s.app.service.mergeRefusal(s.sessionId, pull({ headSha: MOVED })), null)
  })

  it('keeps a ticket with an open PR waiting for a person after every new run, and after its work changes', () => {
    const s = session()
    const a = s.join('alice')
    const b = s.join('bob')
    const ticket = landed(s, a, b)
    s.run(a, { type: 'ticket.needsHuman', ticketId: ticket.id, value: true })
    s.run(b, pass(ticket.id))
    s.run(b, { type: 'ticket.humanCheck', ticketId: ticket.id, passed: true, note: 'clicked through it' })
    s.run(a, { type: 'ticket.shipped', ticketId: ticket.id, prNumber: 7 })
    assert.equal(s.state().ticketStateFor(ticket.id), 'review')
    assert.equal(s.app.service.mergeRefusal(s.sessionId, pull()), null)

    // The branch moved, so it is run again from review: the open PR is no way round a new look.
    s.run(b, pass(ticket.id, MOVED))
    assert.equal(s.state().tickets.get(ticket.id).humanCheck, null, 'the last look was at another build')
    assert.equal(s.state().ticketStateFor(ticket.id), 'verify', 'a PR number does not stand in for a person')
    assert.match(s.app.service.mergeRefusal(s.sessionId, pull({ headSha: MOVED })), /"Pay": it is in verify/)
    s.run(b, { type: 'ticket.humanCheck', ticketId: ticket.id, passed: true, note: 'tried it again' })
    assert.equal(s.state().ticketStateFor(ticket.id), 'review')
    assert.equal(s.app.service.mergeRefusal(s.sessionId, pull({ headSha: MOVED })), null)

    // Its work is reopened and lands again: the run and the look both stop counting.
    s.run(a, { type: 'task.testResult', taskId: 'p-one', result: { passed: true, command: 'npm test', exitCode: 0, summary: 'ok', ranAt: Date.now() } })
    assert.equal(s.state().tickets.get(ticket.id).humanCheck, null)
    s.run(a, { type: 'task.merged', taskId: 'p-one' })
    assert.equal(s.state().ticketStateFor(ticket.id), 'verify')
    assert.match(s.app.service.mergeRefusal(s.sessionId, pull({ headSha: MOVED })), /changed after it passed/)
    s.run(b, pass(ticket.id, MOVED))
    assert.equal(s.state().ticketStateFor(ticket.id), 'verify', 'a fresh pass still waits for a person')
    assert.match(s.app.service.mergeRefusal(s.sessionId, pull({ headSha: MOVED })), /it is in verify/)
    s.run(b, { type: 'ticket.humanCheck', ticketId: ticket.id, passed: true, note: 'and again' })
    assert.equal(s.app.service.mergeRefusal(s.sessionId, pull({ headSha: MOVED })), null)
  })

  it('treats a pass recorded before commits were named as no pass at all', () => {
    const s = session()
    const a = s.join('alice')
    const b = s.join('bob')
    const ticket = landed(s, a, b)
    s.app.store.append(s.sessionId, b.participantId, {
      type: 'ticket.verified',
      ticketId: ticket.id,
      verification: { passed: true, how: 'old plugin', summary: 'ok', broke: [], by: b.participantId, at: 1 },
    })
    s.app.store.append(s.sessionId, b.participantId, { type: 'ticket.shipped', ticketId: ticket.id, prNumber: 7 })
    s.app.service.reload(s.sessionId)

    assert.equal(s.state().ticketStateFor(ticket.id), 'verify', 'a PR number does not make an unbound pass count')
    assert.match(s.app.service.mergeRefusal(s.sessionId, pull()), /predates runs naming a commit/)
    // And it can be run again from there, which is the way out.
    s.run(b, pass(ticket.id))
    assert.equal(s.app.service.mergeRefusal(s.sessionId, pull()), null)
  })

  it('reopens failed work without the test that let it land last time', () => {
    const s = session()
    const a = s.join('alice')
    const b = s.join('bob')
    const { ticket } = liveTicket(s, a, b, 'Pay', 'src/p/c.ts', [spec('p-one', ['src/p/x/**'])])
    s.run(a, { type: 'task.claim', taskId: 'p-one' })
    s.run(a, { type: 'task.testResult', taskId: 'p-one', result: { passed: true, command: 'npm test', exitCode: 0, summary: 'ok', ranAt: 1 } })
    s.run(a, { type: 'task.merged', taskId: 'p-one' })
    assert.equal(s.state().tasks.get('p-one').lastTest.passed, true)

    s.run(b, { type: 'ticket.verified', ticketId: ticket.id, passed: false, how: 'playwright', summary: 'broken', broke: ['p-one'], commitSha: HEAD })
    assert.equal(s.state().tasks.get('p-one').state, 'ready')
    assert.equal(s.state().tasks.get('p-one').lastTest, null, 'it has to prove itself again')
    assert.match(s.app.service.mergeRefusal(s.sessionId, pull()), /not the pull request of any open ticket/)
  })

  it('merges only the ticket PR, from the contract into the base, in this repository', () => {
    const s = session()
    const a = s.join('alice')
    const b = s.join('bob')
    const ticket = landed(s, a, b)
    s.run(b, pass(ticket.id))
    s.run(a, { type: 'ticket.shipped', ticketId: ticket.id, prNumber: 7 })
    const refuse = (over, why) => assert.match(s.app.service.mergeRefusal(s.sessionId, pull(over)), why)

    refuse({ number: 99 }, /not the pull request of any open ticket/)
    refuse({ open: false }, /not open/)
    refuse({ headRepo: 'mallory/web' }, /not a branch of acme\/web/)
    refuse({ headRef: 'feature/other' }, /a ticket ships as ss\/sm\/contract → main/)
    refuse({ baseRef: 'release' }, /a ticket ships as/)
    assert.equal(s.app.service.mergeRefusal(s.sessionId, pull()), null)
  })

  it('will not merge the shared branch while another ticket on it is unproven', () => {
    const s = session()
    const a = s.join('alice')
    const b = s.join('bob')
    const ticket = landed(s, a, b, ['p-one'])
    s.run(b, pass(ticket.id))
    s.run(a, { type: 'ticket.shipped', ticketId: ticket.id, prNumber: 7 })

    // A second ticket's work lands on the same contract branch after the PR was opened.
    const other = liveTicket(s, a, b, 'Other', 'src/q/c.ts', [spec('q-one', ['src/q/x/**'])])
    s.run(a, { type: 'task.claim', taskId: 'q-one' })
    s.run(a, { type: 'task.merged', taskId: 'q-one' })
    assert.match(s.app.service.mergeRefusal(s.sessionId, pull({ headSha: MOVED })), /"Other": never run/)

    // Both run at the new head: the first ticket is re-run from review, which is allowed.
    s.run(b, pass(other.ticket.id, MOVED))
    s.run(b, pass(ticket.id, MOVED))
    assert.equal(s.app.service.mergeRefusal(s.sessionId, pull({ headSha: MOVED })), null)

    // Approved, but nothing of it is on the branch yet: it is not in the PR, so it holds nothing up.
    const later = ticketWithSplit(s, a, b, 'Later', 'src/r/c.ts', [spec('r-one', ['src/r/x/**'])])
    s.run(a, { type: 'ticket.approve', ticketId: later.ticket.id })
    assert.ok(s.state().tasksOfTicket(later.ticket.id).length > 0)
    assert.equal(s.app.service.mergeRefusal(s.sessionId, pull({ headSha: MOVED })), null)
    s.run(a, { type: 'contract.committed', branch: 'ss/sm/contract', commitSha: 'def', ticketId: later.ticket.id })
    assert.match(s.app.service.mergeRefusal(s.sessionId, pull({ headSha: MOVED })), /"Later"/, 'its contract landing puts it aboard')
  })
})
