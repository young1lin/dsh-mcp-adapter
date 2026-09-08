/**
 * P3.7-P4 IPC surface e2e: mcp lifecycle + toggles + memory, tunnels CRUD
 * and port diagnostics — against the real engine child.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MCP_GATEWAY_MASTER_KEY = 'ef'.repeat(32)

const { createEngineSupervisor } = await import('../dist/runtime/engine-supervisor.js')

async function withEngine(run) {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-domains-'))
  const sup = createEngineSupervisor({ storageDir: dir }, { info: () => {}, warn: () => {} })
  try {
    await sup.ensure()
    await run(sup)
  } finally {
    await sup.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
}

test('mcp lifecycle + toggles + memory over IPC', async () => {
  await withEngine(async (sup) => {
    const ensured = await sup.request('mcp.ensure', { name: 't1', def: { type: 'echo' }, start: true }, { timeoutMs: 30000 })
    assert.equal(ensured.lifecycle, 'started')

    const tools = await sup.request('mcp.tools', { name: 't1' }, { timeoutMs: 30000 })
    assert.equal(tools.tools[0].name, 'echo')
    assert.deepEqual(tools.disabledTools, [])

    // echo has no toggle (it serves one fixed tool and owns no set); every
    // other adapter that serves tools has one now, proxies included. mysql is
    // used here because it owns its set without connecting to anything.
    const db = await sup.request('mcp.ensure', { name: 'dbt', def: { type: 'mysql', host: '127.0.0.1', user: 'u', password: 'p', database: 'd' }, start: false }, { timeoutMs: 30000 })
    assert.equal(db.lifecycle, 'stopped')
    const toggled = await sup.request('mcp.setToolEnabled', { name: 'dbt', tool: 'mysql_query', enabled: false }, { timeoutMs: 30000 })
    assert.equal(toggled.enabled, false)
    assert.deepEqual(toggled.disabledTools, ['mysql_query'])
    const unsupported = await sup.request('mcp.setToolEnabled', { name: 't1', tool: 'echo', enabled: false }, { timeoutMs: 30000 }).catch((e) => e.code)
    assert.equal(unsupported, 'E_INTERNAL', 'echo answers unsupported honestly')

    const mem = await sup.request('engine.memory', undefined, { timeoutMs: 30000 })
    assert.ok(typeof mem.rssMb === 'number' || typeof mem === 'object')

    const stopped = await sup.request('mcp.stop', { name: 't1' }, { timeoutMs: 30000 })
    assert.equal(stopped.lifecycle, 'stopped')
    const started = await sup.request('mcp.start', { name: 't1' }, { timeoutMs: 30000 })
    assert.equal(started.lifecycle, 'started')
    const removed = await sup.request('mcp.remove', { name: 't1' }, { timeoutMs: 30000 })
    assert.equal(removed.removed, 't1')
  })
})

test('tunnels CRUD + port diagnostics over IPC (masked secrets)', async () => {
  await withEngine(async (sup) => {
    const created = await sup.request('tunnels.upsertConnection', {
      input: { name: 'bastion', host: '127.0.0.1', port: 22, username: 'u', authType: 'password', password: 'sekret' },
    }, { timeoutMs: 30000 })
    assert.equal(created.connection.name, 'bastion')
    assert.equal(created.connection.password, '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022', 'secret masked on the way out')
    const connId = created.connection.id

    const list1 = await sup.request('tunnels.list', undefined, { timeoutMs: 30000 })
    assert.equal(list1.connections.length, 1)
    assert.equal(list1.connections[0].password, undefined, 'list DTOs carry no secret at all')

    // sentinel round-trip: edit keeps the stored password
    const updated = await sup.request('tunnels.upsertConnection', {
      id: connId,
      input: { name: 'bastion', host: '127.0.0.2', port: 22, username: 'u', authType: 'password', password: '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' },
    }, { timeoutMs: 30000 })
    assert.equal(updated.connection.host, '127.0.0.2')
    assert.equal(updated.connection.password, '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022')

    const rule = await sup.request('tunnels.upsertRule', {
      input: { name: 'db', connectionId: connId, localPort: 15432, targetHost: 'db', targetPort: 5432 },
    }, { timeoutMs: 30000 })
    assert.ok(rule.rule.id, 'rule created with allocated id')
    const badRule = await sup.request('tunnels.upsertRule', {
      input: { name: 'bad', connectionId: connId, localPort: 0, targetHost: 'x', targetPort: 1 },
    }, { timeoutMs: 30000 }).catch((e) => e.message)
    assert.ok(String(badRule).includes('port'), 'invalid port refused')

    const deleted = await sup.request('tunnels.deleteRule', { id: rule.rule.id }, { timeoutMs: 30000 })
    assert.equal(deleted.deleted, rule.rule.id)
    // connection still has no rules; delete succeeds
    const delConn = await sup.request('tunnels.deleteConnection', { id: connId }, { timeoutMs: 30000 })
    assert.equal(delConn.deleted, connId)

    const port = await sup.request('tunnels.port', { port: 19999 }, { timeoutMs: 30000 })
    assert.equal(typeof port.free, 'boolean')
  })
})

test('mcp.ensure hosts ONE instance per definition, whatever name is asked for', async () => {
  await withEngine(async (sup) => {
    // The same definition arriving under two names is two callers reaching for
    // one server: a session mints s<workspace>-<def>-<tail>, the settings panel
    // asks for the catalog name. Registering both built a second COPY — for a
    // stdio child, an entire second process tree.
    const def = { type: 'echo' }
    const first = await sup.request('mcp.ensure', { name: 'sdeadbeef01-c0ffee0002-shared', def, start: true }, { timeoutMs: 30000 })
    assert.equal(first.name, 'sdeadbeef01-c0ffee0002-shared')
    assert.equal(first.reused, undefined, 'the first caller creates it')

    const second = await sup.request('mcp.ensure', { name: 'shared', def, start: true }, { timeoutMs: 30000 })
    assert.equal(second.name, 'sdeadbeef01-c0ffee0002-shared', 'answered with the instance already hosting this def')
    assert.equal(second.reused, true, 'and says so, so the caller re-addresses')
    assert.equal(second.lifecycle, 'started')

    const engine = await sup.request('engine.status', undefined, { timeoutMs: 30000 })
    const mine = engine.mcps.filter((m) => m.name.endsWith('shared'))
    assert.equal(mine.length, 1, 'one instance, not two: ' + mine.map((m) => m.name).join(', '))

    // The name it answered is the one that works; the name it refused to
    // register is not addressable, which is exactly why the reply is binding.
    const tools = await sup.request('mcp.tools', { name: second.name }, { timeoutMs: 30000 })
    assert.equal(tools.tools[0].name, 'echo')
    await assert.rejects(() => sup.request('mcp.tools', { name: 'shared' }, { timeoutMs: 30000 }), /unknown MCP/)
  })
})

test('mcp.ensure still separates definitions that differ at all', async () => {
  await withEngine(async (sup) => {
    // The def hash is the isolation — a per-project override or another API key
    // hashes differently and keeps an instance of its own. Sharing must never
    // reach across that.
    const a = await sup.request('mcp.ensure', { name: 'left', def: { type: 'mysql', host: '127.0.0.1', user: 'u', password: 'p', database: 'one' }, start: false }, { timeoutMs: 30000 })
    const b = await sup.request('mcp.ensure', { name: 'right', def: { type: 'mysql', host: '127.0.0.1', user: 'u', password: 'p', database: 'two' }, start: false }, { timeoutMs: 30000 })
    assert.equal(a.name, 'left')
    assert.equal(b.name, 'right', 'a different database is a different server')
    assert.equal(b.reused, undefined)
  })
})

test('a tool turned off stays off when the entry is re-hosted under a new instance', async () => {
  await withEngine(async (sup) => {
    // The toggle used to be filed under the registry name, which for a session
    // instance carries a hash of the definition: editing the server (or simply
    // restarting into a differently-minted name) silently switched every tool
    // back on.
    const one = 'saaaaaaaaaa-1111111111-dbt'
    const two = 'saaaaaaaaaa-2222222222-dbt' // same entry, next generation
    await sup.request('mcp.ensure', { name: one, def: { type: 'mysql', host: '127.0.0.1', user: 'u', password: 'p', database: 'd' }, start: false }, { timeoutMs: 30000 })
    const off = await sup.request('mcp.setToolEnabled', { name: one, tool: 'mysql_query', enabled: false }, { timeoutMs: 30000 })
    assert.deepEqual(off.disabledTools, ['mysql_query'])

    await sup.request('mcp.ensure', { name: two, def: { type: 'mysql', host: '127.0.0.1', user: 'u', password: 'p', database: 'other' }, start: true }, { timeoutMs: 30000 })
    const listed = await sup.request('mcp.tools', { name: two }, { timeoutMs: 30000 })
    assert.deepEqual(listed.disabledTools, ['mysql_query'], 'the new instance came up with what the user had turned off')
    assert.ok(!listed.tools.some((t) => t.name === 'mysql_query'), 'and it is not served')
  })
})
