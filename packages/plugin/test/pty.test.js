import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { spawnPty } from '../dist/pty.js'

/**
 * The pseudo-terminal a board terminal runs in, without a native module. The
 * program inside has to believe it is on a real terminal of the right size,
 * and has to go when the board says stop -- even if it would rather not.
 */

const home = mkdtempSync(join(tmpdir(), 'ss-pty-'))
after(() => rmSync(home, { recursive: true, force: true }))

function run(script, { cols = 120, rows = 40, python } = {}) {
  let output = ''
  let resolveExit
  const exited = new Promise((resolve) => (resolveExit = resolve))
  const pty = spawnPty({
    command: 'bash',
    args: ['-c', script],
    cwd: home,
    cols,
    rows,
    python,
    onData: (data) => (output += data.toString()),
    onExit: (code, reason) => resolveExit({ code, reason }),
  })
  return { pty, exited, output: () => output }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

describe('the pseudo-terminal', () => {
  it('is a terminal, of the size it was asked for', async () => {
    const t = run('stty size; [ -t 0 ] && echo is-a-tty; exit 4', { cols: 132, rows: 43 })
    const { code } = await t.exited
    assert.equal(code, 4)
    assert.match(t.output(), /43 132/)
    assert.match(t.output(), /is-a-tty/)
  })

  it('takes keys in and tells the program when the window changes', async () => {
    const t = run('trap "stty size" WINCH; read line; echo "got:$line"; sleep 0.5; sleep 0.5')
    await wait(300)
    t.pty.write('hello\r')
    await wait(300)
    t.pty.resize(90, 25)
    await t.exited
    assert.match(t.output(), /got:hello/)
    assert.match(t.output(), /25 90/)
  })

  it('stops a program that ignores the hang-up', async () => {
    const t = run('trap "" HUP; sleep 30')
    await wait(300)
    const started = Date.now()
    t.pty.kill()
    const { code } = await t.exited
    assert.equal(code, 137)
    assert.ok(Date.now() - started < 6000)
  })

  it('says so when python is not there', async () => {
    const t = run('true', { python: 'no-such-python-here' })
    const { code, reason } = await t.exited
    assert.equal(code, null)
    assert.match(reason, /python3 is not installed/)
  })
})
