import { strict as assert } from 'node:assert'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

/**
 * A guest who updated the plugin against a host who has not. The old server
 * ignores `afterId` and only ever answers with the newest messages; the inbox
 * has to move its cursor anyway, or every pull hands the same directives over.
 */
let server
let home
const room = []

const message = (id, body, directive = true) => ({
  id,
  sessionId: 's',
  authorId: 'alice',
  authorKind: 'human',
  body,
  taskRef: null,
  mentions: [],
  directive,
  createdAt: Date.now(),
})

before(async () => {
  home = mkdtempSync(join(tmpdir(), 'ss-inbox-'))
  process.env.SESSION_SHARE_HOME = home
  server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      const { command } = JSON.parse(raw)
      res.setHeader('content-type', 'application/json')
      // Exactly what a 0.9 server sends: no latestId, no cursorFound.
      res.end(JSON.stringify({ data: { messages: room.slice(-command.limit) } }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
})

after(() => {
  server.close()
  rmSync(home, { recursive: true, force: true })
})

describe('an inbox talking to a server from before 0.10', () => {
  it('hands each directive over once', async () => {
    const { markCaughtUp, pendingDirectives } = await import('../dist/inbox.js')
    const config = {
      serverUrl: `http://127.0.0.1:${server.address().port}`,
      sessionRef: 's',
      participantId: 'bob',
      participantToken: 't',
      githubLogin: 'bob',
      displayName: 'Bob',
      repoPath: home,
    }
    room.push(message('m0', 'from before bob joined'))
    await markCaughtUp(config)
    assert.deepEqual(await pendingDirectives(config), [])

    room.push(message('m1', 'first'), message('m2', 'chatter', false), message('m3', 'second'))
    assert.deepEqual(
      (await pendingDirectives(config)).map((m) => m.id),
      ['m1', 'm3'],
    )
    assert.deepEqual(await pendingDirectives(config), [], 'and not again')
    assert.deepEqual(await pendingDirectives(config), [])
  })
})
