import { strict as assert } from 'node:assert'
import { after, describe, it } from 'node:test'
import { ClientCommand, SessionState } from '@session-share/protocol'
import { createApp } from '../dist/index.js'

/**
 * Descriptions, subtickets, comments and sprints: the parts of a ticket that
 * people keep up by hand, driven in-process the way the board sends them.
 */

const REPO = { owner: 'acme', name: 'web', baseBranch: 'main', remoteUrl: 'x' }
const DAY = 24 * 60 * 60 * 1000

const apps = []
after(async () => {
  for (const app of apps) await app.close()
})

function session() {
  const app = createApp({ dbPath: ':memory:' })
  apps.push(app)
  const run = (ctx, command) => app.service.handle(ClientCommand.parse(command), ctx)
  const { sessionId } = run(
    { sessionId: null, participantId: null },
    { type: 'session.create', slug: 'pl', title: 'Planning', repo: REPO },
  )
  const join = (login, repoPath = `/tmp/${login}`) => {
    const user = { id: login, githubLogin: login, displayName: login, avatarUrl: null }
    const ctx = { sessionId: null, participantId: null, user }
    run(ctx, { type: 'session.join', sessionRef: 'pl', repoPath, fromSeq: 0 })
    return ctx
  }
  const fails = (ctx, command, code) => {
    assert.throws(() => run(ctx, command), (error) => error.code === code, `expected ${code}`)
  }
  const state = () => app.service.state(sessionId)
  /** The log folded from nothing has to land where the live projection is. */
  const replayed = () => {
    const fresh = new SessionState()
    for (const envelope of app.store.readEvents(sessionId, 0, 100_000)) fresh.apply(envelope)
    return fresh.snapshot()
  }
  return { app, run, join, fails, sessionId, state, replayed }
}

describe('ticket descriptions', () => {
  it('rewrites the title and description, keeping whatever was left out', () => {
    const s = session()
    const a = s.join('alice')
    const { ticket } = s.run(a, { type: 'ticket.create', title: 'Dark mode', body: 'old' })

    s.run(a, { type: 'ticket.edit', ticketId: ticket.id, body: 'a long\n\ndescription' })
    let now = s.state().tickets.get(ticket.id)
    assert.equal(now.title, 'Dark mode')
    assert.equal(now.body, 'a long\n\ndescription')

    s.run(a, { type: 'ticket.edit', ticketId: ticket.id, title: 'Dark theme' })
    now = s.state().tickets.get(ticket.id)
    assert.equal(now.title, 'Dark theme')
    assert.equal(now.body, 'a long\n\ndescription')
  })

  it('writes nothing to the log when nothing changed', () => {
    const s = session()
    const a = s.join('alice')
    const { ticket } = s.run(a, { type: 'ticket.create', title: 'Same', body: 'same' })
    const before = s.state().seq
    s.run(a, { type: 'ticket.edit', ticketId: ticket.id, title: 'Same', body: 'same' })
    assert.equal(s.state().seq, before)
  })

  it('accepts a description far longer than a brief used to be', () => {
    const s = session()
    const a = s.join('alice')
    const body = 'x'.repeat(15_000)
    const { ticket } = s.run(a, { type: 'ticket.create', title: 'Long', body })
    assert.equal(s.state().tickets.get(ticket.id).body.length, 15_000)
  })
})

describe('subtickets', () => {
  it('starts with whoever added it, and lets others join and leave it', () => {
    const s = session()
    const a = s.join('alice')
    const b = s.join('bob')
    const { ticket } = s.run(a, { type: 'ticket.create', title: 'Checkout' })
    const { subticket } = s.run(a, { type: 'subticket.add', ticketId: ticket.id, title: 'Card form' })
    assert.deepEqual(subticket.members, [a.participantId])
    assert.equal(subticket.state, 'todo')

    s.run(b, { type: 'subticket.join', ticketId: ticket.id, subticketId: subticket.id })
    let now = s.state().tickets.get(ticket.id).subtickets[0]
    assert.deepEqual(now.members, [a.participantId, b.participantId])

    s.run(a, { type: 'subticket.leave', ticketId: ticket.id, subticketId: subticket.id })
    now = s.state().tickets.get(ticket.id).subtickets[0]
    assert.deepEqual(now.members, [b.participantId])
  })

  it('does not put someone into the ticket split by joining one of its pieces', () => {
    const s = session()
    const a = s.join('alice')
    const b = s.join('bob')
    const { ticket } = s.run(a, { type: 'ticket.create', title: 'Checkout' })
    const { subticket } = s.run(a, { type: 'subticket.add', ticketId: ticket.id, title: 'Card form' })
    s.run(b, { type: 'subticket.join', ticketId: ticket.id, subticketId: subticket.id })
    assert.deepEqual(s.state().tickets.get(ticket.id).members, [a.participantId])
  })

  it('moves through todo, doing and done, and can be renamed and removed', () => {
    const s = session()
    const a = s.join('alice')
    const { ticket } = s.run(a, { type: 'ticket.create', title: 'Checkout' })
    const { subticket } = s.run(a, { type: 'subticket.add', ticketId: ticket.id, title: 'Card form' })

    s.run(a, { type: 'subticket.update', ticketId: ticket.id, subticketId: subticket.id, state: 'doing' })
    s.run(a, { type: 'subticket.update', ticketId: ticket.id, subticketId: subticket.id, title: 'Card + 3DS' })
    let now = s.state().tickets.get(ticket.id).subtickets[0]
    assert.equal(now.state, 'doing')
    assert.equal(now.title, 'Card + 3DS')

    s.run(a, { type: 'subticket.remove', ticketId: ticket.id, subticketId: subticket.id })
    assert.equal(s.state().tickets.get(ticket.id).subtickets.length, 0)
  })

  it('refuses a subticket the ticket does not have', () => {
    const s = session()
    const a = s.join('alice')
    const { ticket } = s.run(a, { type: 'ticket.create', title: 'Checkout' })
    s.fails(a, { type: 'subticket.join', ticketId: ticket.id, subticketId: 'nope' }, 'not_found')
  })
})

describe('comments', () => {
  it('stays with the ticket, and only its author can change or remove it', () => {
    const s = session()
    const a = s.join('alice')
    const b = s.join('bob')
    const { ticket } = s.run(a, { type: 'ticket.create', title: 'Search' })
    const { comment } = s.run(b, { type: 'comment.add', ticketId: ticket.id, body: 'use the index' })
    assert.equal(comment.authorId, b.participantId)

    s.fails(a, { type: 'comment.edit', commentId: comment.id, body: 'mine now' }, 'forbidden')
    s.fails(a, { type: 'comment.delete', commentId: comment.id }, 'forbidden')

    s.run(b, { type: 'comment.edit', commentId: comment.id, body: 'use the trigram index' })
    const edited = s.state().comments.get(comment.id)
    assert.equal(edited.body, 'use the trigram index')
    assert.ok(edited.editedAt)

    s.run(b, { type: 'comment.delete', commentId: comment.id })
    assert.equal(s.state().comments.size, 0)
  })

  it('lets the same person edit from another of their checkouts', () => {
    const s = session()
    const one = s.join('alice', '/tmp/alice-1')
    const two = s.join('alice', '/tmp/alice-2')
    assert.notEqual(one.participantId, two.participantId)
    const { ticket } = s.run(one, { type: 'ticket.create', title: 'Search' })
    const { comment } = s.run(one, { type: 'comment.add', ticketId: ticket.id, body: 'first' })
    s.run(two, { type: 'comment.edit', commentId: comment.id, body: 'second' })
    assert.equal(s.state().comments.get(comment.id).body, 'second')
  })

  it('goes when its ticket is deleted', () => {
    const s = session()
    const a = s.join('alice')
    const { ticket } = s.run(a, { type: 'ticket.create', title: 'Search' })
    s.run(a, { type: 'comment.add', ticketId: ticket.id, body: 'hm' })
    s.run(a, { type: 'ticket.delete', ticketId: ticket.id })
    assert.equal(s.state().comments.size, 0)
    assert.equal(s.replayed().comments.length, 0)
  })
})

describe('sprints', () => {
  it('plans tickets into a sprint and back to the backlog', () => {
    const s = session()
    const a = s.join('alice')
    const start = Date.now()
    const { sprint } = s.run(a, { type: 'sprint.create', name: 'Sprint 1', startsAt: start, endsAt: start + 14 * DAY })
    const { ticket } = s.run(a, { type: 'ticket.create', title: 'Login', sprintId: sprint.id })
    assert.equal(s.state().tickets.get(ticket.id).sprintId, sprint.id)

    s.run(a, { type: 'ticket.setSprint', ticketId: ticket.id, sprintId: null })
    assert.equal(s.state().tickets.get(ticket.id).sprintId, null)
  })

  it('runs one sprint at a time', () => {
    const s = session()
    const a = s.join('alice')
    const start = Date.now()
    const one = s.run(a, { type: 'sprint.create', name: 'One', startsAt: start, endsAt: start + 7 * DAY }).sprint
    const two = s.run(a, { type: 'sprint.create', name: 'Two', startsAt: start + 7 * DAY, endsAt: start + 14 * DAY }).sprint
    s.run(a, { type: 'sprint.update', sprintId: one.id, state: 'active' })
    s.fails(a, { type: 'sprint.update', sprintId: two.id, state: 'active' }, 'conflict')
    s.run(a, { type: 'sprint.update', sprintId: one.id, state: 'closed' })
    s.run(a, { type: 'sprint.update', sprintId: two.id, state: 'active' })
    assert.equal(s.state().sprints.get(two.id).state, 'active')
  })

  it('refuses a sprint that ends before it starts, and planning into a closed one', () => {
    const s = session()
    const a = s.join('alice')
    const start = Date.now()
    s.fails(a, { type: 'sprint.create', name: 'Backwards', startsAt: start, endsAt: start - DAY }, 'bad_request')
    const { sprint } = s.run(a, { type: 'sprint.create', name: 'Done', startsAt: start, endsAt: start + DAY })
    s.run(a, { type: 'sprint.update', sprintId: sprint.id, state: 'closed' })
    const { ticket } = s.run(a, { type: 'ticket.create', title: 'Late' })
    s.fails(a, { type: 'ticket.setSprint', ticketId: ticket.id, sprintId: sprint.id }, 'conflict')
  })

  it('sends its tickets back to the backlog when deleted', () => {
    const s = session()
    const a = s.join('alice')
    const start = Date.now()
    const { sprint } = s.run(a, { type: 'sprint.create', name: 'Gone', startsAt: start, endsAt: start + DAY })
    const { ticket } = s.run(a, { type: 'ticket.create', title: 'Stays', sprintId: sprint.id })
    const { ticketsMoved } = s.run(a, { type: 'sprint.delete', sprintId: sprint.id })
    assert.equal(ticketsMoved, 1)
    assert.equal(s.state().tickets.get(ticket.id).sprintId, null)
    assert.equal(s.state().sprints.size, 0)
  })
})

describe('the timeline fields', () => {
  it('records a due date, and when a ticket first left the plan column', () => {
    const s = session()
    const a = s.join('alice')
    const { ticket } = s.run(a, { type: 'ticket.create', title: 'Timed' })
    const due = Date.now() + 3 * DAY
    s.run(a, { type: 'ticket.setDue', ticketId: ticket.id, dueAt: due })
    assert.equal(s.state().tickets.get(ticket.id).dueAt, due)
    assert.equal(s.state().tickets.get(ticket.id).startedAt, null)

    s.run(a, { type: 'ticket.start', ticketId: ticket.id })
    assert.ok(s.state().tickets.get(ticket.id).startedAt)
  })
})

describe('the log', () => {
  it('folds from nothing to the same planning state', () => {
    const s = session()
    const a = s.join('alice')
    const b = s.join('bob')
    const start = Date.now()
    const { sprint } = s.run(a, { type: 'sprint.create', name: 'S', startsAt: start, endsAt: start + DAY })
    const { ticket } = s.run(a, { type: 'ticket.create', title: 'T', sprintId: sprint.id })
    s.run(a, { type: 'ticket.edit', ticketId: ticket.id, body: 'described' })
    const { subticket } = s.run(a, { type: 'subticket.add', ticketId: ticket.id, title: 'piece' })
    s.run(b, { type: 'subticket.join', ticketId: ticket.id, subticketId: subticket.id })
    s.run(b, { type: 'subticket.update', ticketId: ticket.id, subticketId: subticket.id, state: 'done' })
    const { comment } = s.run(b, { type: 'comment.add', ticketId: ticket.id, body: 'said' })
    s.run(b, { type: 'comment.edit', commentId: comment.id, body: 'said better' })
    s.run(a, { type: 'sprint.update', sprintId: sprint.id, state: 'active' })

    const live = s.state().snapshot()
    const replay = s.replayed()
    assert.deepEqual(replay.tickets, live.tickets)
    assert.deepEqual(replay.comments, live.comments)
    assert.deepEqual(replay.sprints, live.sprints)
  })

  it('hydrates a snapshot from a server older than these fields', () => {
    const s = session()
    const a = s.join('alice')
    s.run(a, { type: 'ticket.create', title: 'Old' })
    const snapshot = s.state().snapshot()
    const old = {
      ...snapshot,
      comments: undefined,
      sprints: undefined,
      tickets: snapshot.tickets.map(({ subtickets, sprintId, dueAt, startedAt, ...rest }) => rest),
    }
    const client = new SessionState()
    client.hydrate(old)
    const ticket = [...client.tickets.values()][0]
    assert.deepEqual(ticket.subtickets, [])
    assert.equal(ticket.sprintId, null)
    assert.equal(client.comments.size, 0)
  })
})
