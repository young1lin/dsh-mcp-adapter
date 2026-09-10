/**
 * P3.7 IPC surface e2e: mcp lifecycle + toggles + memory, def-hash instance
 * sharing, and toggle persistence across instance changes — against the real
 * engine child.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.MCP_GATEWAY_MASTER_KEY = 'ef'.repeat(32)

const { createEngineSupervisor } = await import('../dist/runtime/engine-supervisor.js')

/** The stdio echo fixture: a real spawned MCP that serves one tool named "echo". */
const ECHO_FIXTURE = fileURLToPath(new URL('./engine/fixtures/stdio-echo.mjs', import.meta.url))

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
    // adapter that serves tools has one now, proxies included. A LAZY proc is
    // used here because it owns its set without spawning anything.
    const proc = await sup.request('mcp.ensure', { name: 'dbt', def: { type: 'proc', command: 'never-run', lazy: true }, start: false }, { timeoutMs: 30000 })
    assert.equal(proc.lifecycle, 'idle')
    const toggled = await sup.request('mcp.setToolEnabled', { name: 'dbt', tool: 'anything', enabled: false }, { timeoutMs: 30000 })
    assert.equal(toggled.enabled, false)
    assert.deepEqual(toggled.disabledTools, ['anything'])
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
    // reach across that. Lazy procs never spawn, so the difference is pure.
    const a = await sup.request('mcp.ensure', { name: 'left', def: { type: 'proc', command: 'never-run', lazy: true, env: { WHICH: 'one' } }, start: false }, { timeoutMs: 30000 })
    const b = await sup.request('mcp.ensure', { name: 'right', def: { type: 'proc', command: 'never-run', lazy: true, env: { WHICH: 'two' } }, start: false }, { timeoutMs: 30000 })
    assert.equal(a.name, 'left')
    assert.equal(b.name, 'right', 'a different environment is a different server')
    assert.equal(b.reused, undefined)
  })
})

test('a tool turned off stays off when the entry is re-hosted under a new instance', async () => {
  await withEngine(async (sup) => {
    // The toggle used to be filed under the registry name, which for a session
    // instance carries a hash of the definition: editing the server (or simply
    // restarting into a differently-minted name) silently switched every tool
    // back on.
    const one = 'saaaaaaaaaa-1111111111-echot'
    const two = 'saaaaaaaaaa-2222222222-echot' // same entry, next generation
    // Native proc defs carry the FULL command line in `command` (standardToNative
    // joins .mcp.json command+args this way; tokenizeCommand splits it back).
    const base = { type: 'proc', command: 'node "' + ECHO_FIXTURE + '"' }
    await sup.request('mcp.ensure', { name: one, def: base, start: false }, { timeoutMs: 30000 })
    const off = await sup.request('mcp.setToolEnabled', { name: one, tool: 'echo', enabled: false }, { timeoutMs: 30000 })
    assert.deepEqual(off.disabledTools, ['echo'])

    // An edited definition (a bumped description) is a NEW instance of the
    // SAME entry — the toggle was filed under the entry, so it must ride over.
    await sup.request('mcp.ensure', { name: two, def: { ...base, description: 'v2' }, start: true }, { timeoutMs: 120000 })
    const listed = await sup.request('mcp.tools', { name: two }, { timeoutMs: 120000 })
    assert.deepEqual(listed.disabledTools, ['echo'], 'the new instance came up with what the user had turned off')
    assert.ok(!listed.tools.some((t) => t.name === 'echo'), 'and it is not served')
  })
})
