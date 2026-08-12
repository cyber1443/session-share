import { strict as assert } from 'node:assert'
import { appendFileSync, cpSync, mkdtempSync, rmSync } from 'node:fs'
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

after(() => {
  daemon?.stopDaemon()
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
