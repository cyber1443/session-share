import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { autoAssign, loadByParticipant } from '../dist/assign.js'

const task = (id, overrides = {}) => ({
  id,
  title: id,
  intent: id,
  ownedPaths: [`src/${id}/**`],
  dependsOn: [],
  assumes: [],
  acceptance: { testCommand: `npm test -- ${id}`, testFiles: [], manualChecks: [] },
  estimateMinutes: 30,
  ...overrides,
})

const owners = (assignments) => Object.fromEntries(assignments.map((a) => [a.taskId, a.participantId]))

describe('autoAssign', () => {
  it('splits work that can run at the same time between people', () => {
    const assignments = autoAssign({
      tasks: [task('a'), task('b')],
      participants: ['alice', 'bob'],
    })
    const by = owners(assignments)
    assert.notEqual(by.a, by.b, 'two tasks at the same depth must not go to one person')
  })

  it('balances by estimated minutes, not by task count', () => {
    const assignments = autoAssign({
      tasks: [
        task('big', { estimateMinutes: 120 }),
        task('small-1', { estimateMinutes: 20 }),
        task('small-2', { estimateMinutes: 20 }),
        task('small-3', { estimateMinutes: 20 }),
      ],
      participants: ['alice', 'bob'],
    })
    const load = loadByParticipant(
      [
        task('big', { estimateMinutes: 120 }),
        task('small-1', { estimateMinutes: 20 }),
        task('small-2', { estimateMinutes: 20 }),
        task('small-3', { estimateMinutes: 20 }),
      ],
      assignments,
    )
    const [alice, bob] = ['alice', 'bob'].map((id) => load.get(id) ?? 0)
    assert.equal(alice + bob, 180)
    // One person taking the 120 and nothing else is the right shape here.
    assert.ok(Math.abs(alice - bob) <= 60, `lopsided: ${alice} vs ${bob}`)
  })

  it('keeps one person inside one area of the tree when it can', () => {
    const tasks = [
      task('lib-1', { ownedPaths: ['src/lib/a.ts'] }),
      task('ui-1', { ownedPaths: ['src/ui/a.tsx'] }),
      task('lib-2', { ownedPaths: ['src/lib/b.ts'], dependsOn: ['lib-1'] }),
      task('ui-2', { ownedPaths: ['src/ui/b.tsx'], dependsOn: ['ui-1'] }),
    ]
    const by = owners(autoAssign({ tasks, participants: ['alice', 'bob'] }))
    assert.equal(by['lib-1'], by['lib-2'], 'the lib pair should stay together')
    assert.equal(by['ui-1'], by['ui-2'], 'so should the ui pair')
    assert.notEqual(by['lib-1'], by['ui-1'])
  })

  it('never moves a card a person placed', () => {
    const tasks = [task('a'), task('b'), task('c'), task('d')]
    const by = owners(
      autoAssign({
        tasks,
        participants: ['alice', 'bob'],
        pinned: [{ taskId: 'a', participantId: 'bob' }],
      }),
    )
    assert.equal(by.a, 'bob')
  })

  it('marks which assignments a person made', () => {
    const assignments = autoAssign({
      tasks: [task('a'), task('b')],
      participants: ['alice', 'bob'],
      pinned: [{ taskId: 'a', participantId: 'bob' }],
    })
    assert.equal(assignments.find((a) => a.taskId === 'a').manual, true)
    assert.equal(assignments.find((a) => a.taskId === 'b').manual, false)
  })

  it('is deterministic, so cards do not move under people', () => {
    const tasks = [task('a'), task('b'), task('c'), task('d'), task('e')]
    const once = autoAssign({ tasks, participants: ['alice', 'bob', 'cara'] })
    const twice = autoAssign({ tasks, participants: ['alice', 'bob', 'cara'] })
    assert.deepEqual(once, twice)
  })

  it('returns assignments in task order', () => {
    const tasks = [task('c'), task('a'), task('b')]
    const assignments = autoAssign({ tasks, participants: ['alice', 'bob'] })
    assert.deepEqual(
      assignments.map((a) => a.taskId),
      ['c', 'a', 'b'],
    )
  })

  it('gives everything to the only person there is', () => {
    const by = owners(autoAssign({ tasks: [task('a'), task('b')], participants: ['alice'] }))
    assert.deepEqual(by, { a: 'alice', b: 'alice' })
  })

  it('assigns nothing when nobody has a checkout', () => {
    assert.deepEqual(autoAssign({ tasks: [task('a')], participants: [] }), [])
  })

  it('ignores a pin naming someone who is not here', () => {
    const by = owners(
      autoAssign({
        tasks: [task('a')],
        participants: ['alice'],
        pinned: [{ taskId: 'a', participantId: 'ghost' }],
      }),
    )
    assert.equal(by.a, 'alice')
  })
})
