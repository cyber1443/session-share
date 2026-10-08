import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, it } from 'node:test'

/**
 * The daemon outlives the Claude Code that started it, which is the point of
 * it -- and also means it outlives a plugin update. These cover the two cases
 * where a perfectly healthy server has to be replaced anyway, both of which
 * looked to a user like "the fix did nothing".
 */
const PORT = Number(process.env.SESSION_SHARE_TEST_PORT ?? 4388)

let home
let serverDir
let entry
let daemon

before(async () => {
  home = mkdtempSync(join(tmpdir(), 'ss-daemon-home-'))
  serverDir = mkdtempSync(join(tmpdir(), 'ss-daemon-server-'))

  /**
   * A copy of the *bundled* server -- the dependency-free single file users
   * actually run -- so "the code changed" can be simulated by changing it,
   * which is exactly what installing a new plugin does. The unbundled dist
   * cannot be copied out of the workspace: it would lose its node_modules.
   */
  const source = new URL('../bundle/server/index.js', import.meta.url).pathname
  entry = join(serverDir, 'index.js')
  cpSync(source, entry)

  process.env.SESSION_SHARE_HOME = home
  process.env.SESSION_SHARE_SERVER_ENTRY = entry
  daemon = await import('../dist/daemon.js')
})

after(async () => {
  await daemon?.stopDaemon()
  rmSync(home, { recursive: true, force: true })
  rmSync(serverDir, { recursive: true, force: true })
})

describe('the daemon and the code it runs', () => {
  it('reports a build that changes when the code does', async () => {
    const before = daemon.expectedBuild()
    assert.match(before, /^[0-9a-f]{12}$/)

    appendFileSync(entry, '\n// a newer plugin\n')
    assert.notEqual(daemon.expectedBuild(), before, 'a changed server must change the build')
  })

  it('starts one, and reuses it while the code is unchanged', async () => {
    const first = await daemon.ensureDaemon({ port: PORT, expose: 'loopback' })
    assert.equal(first.port, PORT)

    const health = await daemon.probe(`http://127.0.0.1:${PORT}`)
    assert.equal(health.build, daemon.expectedBuild(), 'the server reports the build it is running')

    const second = await daemon.ensureDaemon({ port: PORT, expose: 'loopback' })
    assert.equal(second.pid, first.pid, 'nothing changed, so nothing should restart')
  })

  it('keeps a healthy one where it is when only the default port differs', async () => {
    const running = await daemon.ensureDaemon({ port: PORT, expose: 'loopback' })
    assert.notEqual(daemon.DEFAULT_PORT, PORT)
    const again = await daemon.ensureDaemon({ expose: 'loopback' })
    assert.equal(again.pid, running.pid, 'a shell exporting another SESSION_SHARE_PORT must not restart it')
    assert.equal(again.port, PORT)
  })

  it('replaces one that is running code the plugin no longer ships', async () => {
    const before = await daemon.ensureDaemon({ port: PORT, expose: 'loopback' })

    // What a plugin update does: the files under the entry point change.
    appendFileSync(entry, '\n// installed by a later version\n')

    const after = await daemon.ensureDaemon({ port: PORT, expose: 'loopback' })
    assert.notEqual(
      after.pid,
      before.pid,
      'a stale daemon serves the old board, so the update has to replace it',
    )

    const health = await daemon.probe(`http://127.0.0.1:${PORT}`)
    assert.equal(health.build, daemon.expectedBuild())
  })
})

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * daemon.json outlives the process it describes. After a crash or a reboot the
 * pid in it belongs to whatever the OS handed it to next, and /ss:stop used to
 * signal it without asking.
 */
describe('stopping', () => {
  it('never signals a pid from a stale record', async () => {
    await daemon.stopDaemon()
    const victim = spawn('sleep', ['30'], { stdio: 'ignore' })
    try {
      writeFileSync(
        daemon.paths.DAEMON_FILE,
        JSON.stringify({ port: PORT + 1, url: 'http://127.0.0.1:1', expose: 'lan', pid: victim.pid, startedAt: 0 }),
      )
      assert.equal(await daemon.stopDaemon(), 'not-running')
      await new Promise((resolve) => setTimeout(resolve, 200))
      assert.equal(alive(victim.pid), true, 'an unrelated process must survive /ss:stop')
      assert.equal(existsSync(daemon.paths.DAEMON_FILE), false, 'and the stale record is gone')
    } finally {
      victim.kill()
    }
  })

  it('stops the server that is answering, whatever the record says', async () => {
    const running = await daemon.ensureDaemon({ port: PORT, expose: 'loopback' })
    const victim = spawn('sleep', ['30'], { stdio: 'ignore' })
    try {
      writeFileSync(daemon.paths.DAEMON_FILE, JSON.stringify({ ...running, pid: victim.pid }))
      assert.equal(await daemon.stopDaemon(), 'stopped')
      assert.equal(await daemon.probe(`http://127.0.0.1:${PORT}`), null, 'the server is down')
      assert.equal(alive(victim.pid), true, 'and only the server was signalled')
    } finally {
      victim.kill()
    }
  })

  /**
   * Two Claude Codes hosting at once each spawn a server; one wins the port
   * and the other exits. Recording the pid each spawned is how a dead pid got
   * written down, which then made the live one impossible to stop or replace.
   */
  it('records the pid of the server that won, when two hosts race', async () => {
    const [a, b] = await Promise.all([
      daemon.ensureDaemon({ port: PORT, expose: 'loopback' }),
      daemon.ensureDaemon({ port: PORT, expose: 'loopback' }),
    ])
    const health = await daemon.probe(`http://127.0.0.1:${PORT}`)
    assert.equal(a.pid, health.pid)
    assert.equal(b.pid, health.pid)
    assert.equal(daemon.readDaemon().pid, health.pid)
    assert.equal(alive(health.pid), true)
  })
})

describe('addresses', () => {
  const iface = (address, internal = false) => [{ address, family: 'IPv4', internal }]

  it('prefers the LAN over bridges and overlays', () => {
    assert.equal(
      daemon.lanAddress({
        'br-1a2b3c': iface('172.18.0.1'),
        veth12: iface('10.200.0.1'),
        wg0: iface('10.8.0.2'),
        tailscale0: iface('100.101.102.103'),
        en0: iface('192.168.1.24'),
      }),
      '192.168.1.24',
    )
  })

  it('falls back to Tailscale when there is nothing else', () => {
    assert.equal(
      daemon.lanAddress({ lo0: iface('127.0.0.1', true), utun4: iface('100.64.1.2'), docker0: iface('172.17.0.1') }),
      '100.64.1.2',
    )
    assert.equal(daemon.lanAddress({ lo0: iface('127.0.0.1', true) }), null)
  })

  it('takes a public URL from the host when it is told one', () => {
    assert.equal(daemon.publicUrlOverride('https://abc.trycloudflare.com/'), 'https://abc.trycloudflare.com')
    assert.throws(() => daemon.publicUrlOverride('ftp://nope'))
    assert.equal(daemon.publicUrlOverride(''), null)
  })
})

describe('the machine', () => {
  it('has one stable id, created once', () => {
    const first = daemon.machineId()
    assert.match(first, /^[0-9a-f-]{36}$/)
    assert.equal(daemon.machineId(), first)
  })
})
