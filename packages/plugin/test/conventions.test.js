import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { gitCommandProblem, subjectProblem, taskMessage, taskSubject } from '../dist/conventions.js'

describe('git conventions', () => {
  it('accepts conventional subjects and rejects the rest', () => {
    assert.equal(subjectProblem('feat(auth): add token refresh'), null)
    assert.equal(subjectProblem('fix!: drop the old flag'), null)
    assert.match(subjectProblem('fixed stuff'), /Conventional/)
    assert.match(subjectProblem('feat: done.'), /period/)
  })

  it('files a plain summary under the task', () => {
    assert.equal(taskSubject('t-1', 'Add the login form.'), 'feat(t-1): add the login form')
    assert.equal(taskSubject('t-1', 'fix(t-1): handle empty input'), 'fix(t-1): handle empty input')
    assert.equal(taskMessage('t-1', 'feat(t-1): x'), 'feat(t-1): x\n\nTask: t-1')
  })

  it('blocks sweeping stages, bad messages and off-session branches', () => {
    assert.match(gitCommandProblem('git add -A'), /explicit path/)
    assert.match(gitCommandProblem('git add .'), /explicit path/)
    assert.equal(gitCommandProblem('git add src/a.ts src/b.ts'), null)
    assert.match(gitCommandProblem('git commit -am "wip"'), /without -a/)
    assert.match(gitCommandProblem('git commit -m "wip"'), /Conventional/)
    assert.equal(gitCommandProblem('git commit -m "feat(t-1): add form"'), null)
    assert.match(gitCommandProblem('git checkout -b feature/x'), /session tools/)
    assert.equal(gitCommandProblem('git checkout -b ss/demo/t-1'), null)
    assert.match(gitCommandProblem('cd x && git -C repo switch -c hotfix'), /session tools/)
    assert.equal(gitCommandProblem('git status && git log --oneline'), null)
    assert.equal(gitCommandProblem('git branch -d old'), null)
  })
})
