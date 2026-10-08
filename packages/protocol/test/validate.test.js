import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { analyzeDag, validateDecomposition } from '../dist/index.js'

const contract = {
  summary: 'Theme types and provider stub',
  files: [
    { path: 'src/lib/theme-types.ts', purpose: 'shared Theme union', contents: '' },
    { path: 'src/lib/theme-context.tsx', purpose: 'provider stub', contents: '' },
  ],
}

function task(id, overrides = {}) {
  return {
    id,
    title: id,
    intent: `do ${id}`,
    ownedPaths: [`src/${id}/**`],
    dependsOn: [],
    assumes: [],
    acceptance: {
      testCommand: `npm test -- ${id}`,
      testFiles: [`src/${id}/${id}.test.ts`],
      manualChecks: [],
    },
    estimateMinutes: 45,
    ...overrides,
  }
}

const codesIn = (report) => report.issues.map((i) => `${i.severity}:${i.code}`)

describe('analyzeDag', () => {
  it('computes depth from the longest path', () => {
    const tasks = [task('a'), task('b', { dependsOn: ['a'] }), task('c', { dependsOn: ['b'] })]
    const { depthByTask } = analyzeDag(tasks)
    assert.equal(depthByTask.get('a'), 0)
    assert.equal(depthByTask.get('b'), 1)
    assert.equal(depthByTask.get('c'), 2)
  })

  it('collects transitive ancestors', () => {
    const tasks = [task('a'), task('b', { dependsOn: ['a'] }), task('c', { dependsOn: ['b'] })]
    const { ancestors } = analyzeDag(tasks)
    assert.deepEqual([...ancestors.get('c')].sort(), ['a', 'b'])
  })

  it('reports a cycle instead of hanging', () => {
    const tasks = [task('a', { dependsOn: ['b'] }), task('b', { dependsOn: ['a'] })]
    const { cycle } = analyzeDag(tasks)
    assert.ok(cycle, 'expected a cycle to be reported')
  })
})

describe('validateDecomposition', () => {
  it('accepts a clean two-way split', () => {
    const report = validateDecomposition({
      contract,
      tasks: [task('theme-toggle'), task('theme-persist')],
      participantCount: 2,
    })
    assert.equal(report.ok, true)
    assert.deepEqual(report.issues, [])
    assert.equal(report.maxFrontier, 2)
  })

  it('blocks two concurrent tasks owning the same path', () => {
    const report = validateDecomposition({
      contract,
      tasks: [
        task('theme-toggle', { ownedPaths: ['src/components/**'] }),
        task('theme-persist', { ownedPaths: ['src/components/theme/*.tsx'] }),
      ],
      participantCount: 2,
    })
    assert.equal(report.ok, false)
    assert.ok(codesIn(report).includes('error:overlapping_paths'))
  })

  it('allows the same overlap when the tasks are sequential', () => {
    const report = validateDecomposition({
      contract,
      tasks: [
        task('theme-toggle', { ownedPaths: ['src/components/**'] }),
        task('theme-persist', {
          ownedPaths: ['src/components/theme/*.tsx'],
          dependsOn: ['theme-toggle'],
        }),
      ],
      participantCount: 1,
    })
    assert.equal(report.ok, true)
    assert.ok(codesIn(report).includes('warning:overlapping_paths'))
  })

  it('detects an overlap across a transitive dependency gap', () => {
    // a -> b -> c means a and c are sequential even though c does not name a.
    const report = validateDecomposition({
      contract,
      tasks: [
        task('a', { ownedPaths: ['src/shared/**'] }),
        task('b', { dependsOn: ['a'] }),
        task('c', { dependsOn: ['b'], ownedPaths: ['src/shared/util.ts'] }),
      ],
      participantCount: 1,
    })
    assert.ok(codesIn(report).includes('warning:overlapping_paths'))
    assert.ok(!codesIn(report).includes('error:overlapping_paths'))
  })

  it('rejects a task that owns a contract file', () => {
    const report = validateDecomposition({
      contract,
      tasks: [task('theme-toggle', { ownedPaths: ['src/lib/**'] }), task('theme-persist')],
      participantCount: 2,
    })
    assert.equal(report.ok, false)
    assert.ok(codesIn(report).includes('error:contract_path_owned_by_task'))
  })

  it('rejects an unknown dependency', () => {
    const report = validateDecomposition({
      contract,
      tasks: [task('a', { dependsOn: ['ghost'] })],
      participantCount: 1,
    })
    assert.equal(report.ok, false)
    assert.ok(codesIn(report).includes('error:unknown_dependency'))
  })

  it('rejects a cycle', () => {
    const report = validateDecomposition({
      contract,
      tasks: [task('a', { dependsOn: ['b'] }), task('b', { dependsOn: ['a'] })],
      participantCount: 2,
    })
    assert.equal(report.ok, false)
    assert.ok(codesIn(report).includes('error:dependency_cycle'))
  })

  it('rejects a task with nothing to prove it', () => {
    const report = validateDecomposition({
      contract,
      tasks: [
        task('a', {
          acceptance: { testCommand: 'npm test', testFiles: [], manualChecks: [] },
        }),
      ],
      participantCount: 1,
    })
    assert.equal(report.ok, false)
    assert.ok(codesIn(report).includes('error:missing_acceptance'))
  })

  it('rejects a glob that escapes the repo', () => {
    const report = validateDecomposition({
      contract,
      tasks: [task('a', { ownedPaths: ['../other-repo/**'] })],
      participantCount: 1,
    })
    assert.equal(report.ok, false)
    assert.ok(codesIn(report).includes('error:path_escapes_repo'))
  })

  /**
   * macOS ignores case, so `.GIT/config` is the repository's own config -- and
   * a git config can name programs git runs on the next commit.
   */
  it('rejects anything aimed into .git, in any case', () => {
    for (const path of ['.git/config', '.GIT/config', 'vendor/lib/.Git/hooks/pre-commit', 'sub/../.GIT/config']) {
      const report = validateDecomposition({
        contract: { summary: 's', files: [{ path, purpose: 'p', contents: '' }] },
        tasks: [task('a')],
        participantCount: 1,
      })
      assert.ok(codesIn(report).includes('error:path_escapes_repo'), path)
    }
    const owned = validateDecomposition({
      contract,
      tasks: [task('a', { ownedPaths: ['.GIT/**'] })],
      participantCount: 1,
    })
    assert.ok(codesIn(owned).includes('error:path_escapes_repo'))
  })

  it('warns when the split is narrower than the team', () => {
    const report = validateDecomposition({
      contract,
      tasks: [task('a'), task('b', { dependsOn: ['a'] })],
      participantCount: 4,
    })
    assert.equal(report.ok, true, 'a narrow split is a warning, not a blocker')
    assert.ok(codesIn(report).includes('warning:narrow_frontier'))
    assert.match(
      report.issues.find((i) => i.code === 'narrow_frontier').message,
      /3 of 4 devs will idle/,
    )
  })

  it('warns on an oversized task', () => {
    const report = validateDecomposition({
      contract,
      tasks: [task('a', { estimateMinutes: 180 })],
      participantCount: 1,
    })
    assert.ok(codesIn(report).includes('warning:oversized_task'))
  })
})

describe('validateDecomposition: ids and case', () => {
  it('rejects two tasks sharing an id', () => {
    const report = validateDecomposition({
      contract,
      tasks: [task('dup'), task('dup', { ownedPaths: ['src/other/**'] })],
      participantCount: 1,
    })
    assert.equal(report.ok, false)
    assert.ok(codesIn(report).includes('error:duplicate_task_id'), codesIn(report).join(', '))
  })

  it('treats paths that differ only in case as the same file', () => {
    const report = validateDecomposition({
      contract,
      tasks: [task('a', { ownedPaths: ['src/Theme.ts'] }), task('b', { ownedPaths: ['src/theme.ts'] })],
      participantCount: 2,
    })
    assert.ok(codesIn(report).includes('error:overlapping_paths'), codesIn(report).join(', '))
  })

  it('catches a task owning a contract file spelled in another case', () => {
    const report = validateDecomposition({
      contract,
      tasks: [task('a', { ownedPaths: ['SRC/lib/**'] })],
      participantCount: 1,
    })
    assert.ok(codesIn(report).includes('error:contract_path_owned_by_task'), codesIn(report).join(', '))
  })
})
