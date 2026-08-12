import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { isLoopbackUrl, packInvite, unpackInvite } from '../dist/invite.js'
import { chooseSeat } from '../dist/seat.js'

describe('invites', () => {
  it('round-trips the address and the token', () => {
    const packed = packInvite({ url: 'http://192.168.1.24:4310', token: 'abc.def' })
    assert.match(packed, /^ssx_/)
    assert.deepEqual(unpackInvite(packed), {
      url: 'http://192.168.1.24:4310',
      token: 'abc.def',
      serverId: null,
    })
  })

  it('carries the fingerprint of the server that minted it', () => {
    const packed = packInvite({
      url: 'http://192.168.1.24:4310/',
      token: 'abc.def',
      serverId: 'deadbeefdeadbeef',
    })
    assert.deepEqual(unpackInvite(packed), {
      url: 'http://192.168.1.24:4310',
      token: 'abc.def',
      serverId: 'deadbeefdeadbeef',
    })
  })

  it('reads an invite minted before fingerprints existed', () => {
    // Exactly what the old packer produced: no `s` key at all.
    const legacy =
      'ssx_' +
      Buffer.from(JSON.stringify({ u: 'http://10.0.0.5:4310', t: 'tok' }), 'utf8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
    assert.deepEqual(unpackInvite(legacy), {
      url: 'http://10.0.0.5:4310',
      token: 'tok',
      serverId: null,
    })
  })

  it('finds the invite inside whatever was pasted', () => {
    const packed = packInvite({ url: 'http://192.168.1.24:4310', token: 'abc.def' })
    for (const pasted of [
      `/ss:join ${packed}`,
      `http://192.168.1.24:4310/board/?join=${packed}&as=alice`,
      `  ${packed}\n`,
    ]) {
      assert.equal(unpackInvite(pasted)?.token, 'abc.def', pasted)
    }
  })

  it('refuses anything that is not an invite', () => {
    assert.equal(unpackInvite('ssj_one-time-code'), null)
    assert.equal(unpackInvite('ssx_not-base64-json'), null)
    assert.equal(unpackInvite(''), null)
  })

  it('refuses a non-http address, so an invite cannot redirect a join', () => {
    const hostile =
      'ssx_' +
      Buffer.from(JSON.stringify({ u: 'file:///etc/passwd', t: 'tok' }), 'utf8').toString('base64url')
    assert.equal(unpackInvite(hostile), null)
  })

  it('knows which addresses only work on the machine that minted them', () => {
    assert.equal(isLoopbackUrl('http://127.0.0.1:4310'), true)
    assert.equal(isLoopbackUrl('http://localhost:4310'), true)
    assert.equal(isLoopbackUrl('http://[::1]:4310'), true)
    assert.equal(isLoopbackUrl('http://192.168.1.24:4310'), false)
    assert.equal(isLoopbackUrl('not a url'), false)
  })
})

describe('choosing which session a board shows', () => {
  const invite = packInvite({ url: 'http://192.168.1.24:4310', token: 'abc.def' })

  it('redeems an invite from the URL even when a token is already stored', () => {
    // The bug this exists to stop: a board showing the session you opened last
    // week instead of the one you were just sent.
    assert.deepEqual(chooseSeat({ invite, hasToken: true }), { kind: 'redeem', invite })
  })

  it('redeems an invite when there is no token at all', () => {
    assert.deepEqual(chooseSeat({ invite, hasToken: false }), { kind: 'redeem', invite })
  })

  it('falls back to the stored token when the URL carries no invite', () => {
    assert.deepEqual(chooseSeat({ invite: null, hasToken: true }), { kind: 'stored' })
  })

  it('asks when there is neither', () => {
    assert.deepEqual(chooseSeat({ invite: null, hasToken: false }), { kind: 'ask' })
  })

  it('ignores junk in the join parameter rather than trying to redeem it', () => {
    assert.deepEqual(chooseSeat({ invite: 'not-an-invite', hasToken: true }), { kind: 'stored' })
    assert.deepEqual(chooseSeat({ invite: '', hasToken: false }), { kind: 'ask' })
  })
})
