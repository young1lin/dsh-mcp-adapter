/**
 * End-to-end IPC integration over the BUILT engine child: the supervisor
 * spawns dist/engine/ipc-main.js exactly the way the dsh host plugin will,
 * handshakes, round-trips the lifecycle methods, and verifies a graceful
 * stop with no leftover process. Runs against dist — build first.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEngineSupervisor, reapOrphanedEngines } from '../dist/runtime/engine-supervisor.js'
import { parseFrame } from '../dist/shared/ipc-protocol.js'

function storage() {
  return mkdtempSync(join(tmpdir(), 'mcp-manager-ipc-'))
}

test('supervisor: spawn, handshake, ping, status, graceful dispose', async () => {
  const dir = storage()
  const lines = []
  const supervisor = createEngineSupervisor({ storageDir: dir }, { info: (l) => lines.push(l), warn: (l) => lines.push(l) })
  try {
    const ready = await supervisor.ensure()
    assert.equal(ready.t, 'ready')
    assert.equal(ready.protocol, 1)
    assert.ok(ready.pid > 0)
    // privateMode (P6.7 default): no public HTTP listener -> httpPort 0.
    assert.equal(ready.httpPort ?? 0, 0, 'private engine reports no public port')

    const pong = await supervisor.request('ping', undefined, { timeoutMs: 10000 })
    assert.equal(pong.pong, true)
    assert.equal(pong.pid, ready.pid)

    const status = await supervisor.request('engine.status', undefined, { timeoutMs: 10000 })
    assert.equal(status.host, '127.0.0.1')
    assert.ok(Array.isArray(status.mcps))
    // privateMode plugin engines seed no demo MCP — the registry starts empty
    // until the host ensures real entries from the merged config.

    assert.equal(supervisor.httpOrigin(), undefined, 'no public origin in private mode')
    assert.equal(supervisor.alive(), true)

    await supervisor.dispose()
    assert.equal(supervisor.alive(), false)
    // ledger cleaned
    assert.equal(existsSync(join(dir, 'runtime')), true)
    const leftovers = reapOrphanedEngines(dir, process.pid, () => {})
    assert.deepEqual(leftovers, [], 'no ledger residue after graceful dispose')
  } finally {
    await supervisor.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('plugin-owned engine refuses HTTP even if legacy supervisor options request publication', async () => {
  const dir = storage()
  const supervisor = createEngineSupervisor({ storageDir: dir, publicMcp: true, httpPort: 0 }, { info: () => {}, warn: () => {} })
  try {
    const ready = await supervisor.ensure()
    assert.equal(ready.httpPort ?? 0, 0, 'child must not bind even an ephemeral HTTP port')
    assert.equal(supervisor.httpOrigin(), undefined)
    const status = await supervisor.request('engine.status', undefined, { timeoutMs: 10000 })
    assert.ok(Array.isArray(status.mcps), 'private IPC still works')
  } finally {
    await supervisor.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('supervisor: request against a disposed engine rejects E_DIED, not a hang', async () => {
  const dir = storage()
  const supervisor = createEngineSupervisor({ storageDir: dir }, { info: () => {}, warn: () => {} })
  await supervisor.ensure()
  await supervisor.dispose()
  await assert.rejects(
    () => supervisor.request('ping', undefined, { timeoutMs: 2000 }),
    (err) => err.code === 'E_DIED',
  )
  rmSync(dir, { recursive: true, force: true })
})

test('supervisor: an unknown method answers E_UNKNOWN_METHOD over the pipe', async () => {
  const dir = storage()
  const supervisor = createEngineSupervisor({ storageDir: dir }, { info: () => {}, warn: () => {} })
  try {
    await supervisor.ensure()
    await assert.rejects(
      () => supervisor.request('no.such.method', undefined, { timeoutMs: 5000 }),
      (err) => err.code === 'E_UNKNOWN_METHOD',
    )
  } finally {
    await supervisor.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('supervisor: a request whose signal is ALREADY aborted settles E_CANCELLED, no hang', async () => {
  const dir = storage()
  const supervisor = createEngineSupervisor({ storageDir: dir }, { info: () => {}, warn: () => {} })
  try {
    await supervisor.ensure()
    const signal = AbortSignal.abort()
    await assert.rejects(
      () => supervisor.request('ping', undefined, { timeoutMs: 5000, signal }),
      (err) => err.code === 'E_CANCELLED',
      'a pre-aborted signal must reject its request instead of stranding it',
    )
  } finally {
    await supervisor.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('supervisor: aborting a request MID-FLIGHT settles E_CANCELLED, never hangs', async () => {
  const dir = storage()
  const supervisor = createEngineSupervisor({ storageDir: dir }, { info: () => {}, warn: () => {} })
  try {
    await supervisor.ensure()
    // A proc whose child spawns but never speaks MCP: the engine's ensure sits
    // in the 60s handshake until the cancel frame aborts it.
    const controller = new AbortController()
    const pending = supervisor.request(
      'mcp.ensure',
      { name: 'mute-child', def: { type: 'proc', command: '"' + process.execPath + '" -e "setTimeout(()=>{},30000)"' }, start: true },
      { timeoutMs: 5000, signal: controller.signal },
    )
    setTimeout(() => controller.abort(), 300)
    const started = Date.now()
    await assert.rejects(
      () => pending,
      (err) => err.code === 'E_CANCELLED',
      'an aborted in-flight request must settle instead of waiting for the engine reply it will never match',
    )
    // It settled via the abort path, not by burning the whole timeout.
    assert.ok(Date.now() - started < 4500, 'settled promptly after abort')
  } finally {
    await supervisor.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('protocol: parseFrame accepts well-formed frames and rejects noise', () => {
  const ready = parseFrame('{"t":"ready","protocol":1,"version":"0.0.0","pid":1}')
  assert.equal(ready.t, 'ready')
  const res = parseFrame('{"t":"res","id":7,"ok":true,"result":{}}')
  assert.equal(res.id, 7)
  assert.equal(parseFrame(''), undefined)
  assert.equal(parseFrame('not json'), undefined)
  assert.equal(parseFrame('{"t":"bogus"}'), undefined)
  assert.equal(parseFrame('[1,2]'), undefined)
})
