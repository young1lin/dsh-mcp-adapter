/** Never reproduce a step wedge against the live host: isolated engine + agent fixtures. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.MCP_GATEWAY_MASTER_KEY = 'cd'.repeat(32)
const { createEngineSupervisor } = await import('../dist/runtime/engine-supervisor.js')
const { createSessionRuntime } = await import('../dist/runtime/session-runtime.js')
const { createConfigService } = await import('../dist/config/service.js')
const { globalStandardLayers, projectStandardLayers } = await import('../dist/config/standard-paths.js')
const { readSessionFile, sessionFilePath } = await import('../dist/config/session-store.js')
const { publishRuntime } = await import('../dist/runtime/engine-shared.js')
const { mountAgentPlane } = await import('../dist/agent.js')

// Independent watchdog: the original BUG cleared the supervisor's own timer.
async function within(promise, ms = 4000) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('regression watchdog: tool body never settled')), ms) })])
  } finally { clearTimeout(timer) }
}

function agentContext() {
  const registered = []
  const cleanup = []
  return {
    registered,
    tools: { register: (tool) => { registered.push(tool); return () => registered.splice(registered.indexOf(tool), 1) } },
    effect: (fn) => { cleanup.push(fn()); return () => {} },
    dispose: () => { for (const fn of cleanup.splice(0)) fn?.() },
  }
}
const quiet = { info: () => {}, warn: (line) => console.error('[fixture]', line), error: () => {} }

test('Claude merge: one tool set per logical name, shared instance, cancelled call settles and both sessions continue', { timeout: 30000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-conversation-'))
  const storageDir = join(dir, 'store')
  const homeDir = join(dir, 'home')
  const root = join(dir, 'ws')
  const marker = join(dir, 'call-started')
  const def = { command: process.execPath, args: [fileURLToPath(new URL('./fixtures/slow-mcp.mjs', import.meta.url))], env: { MCP_TEST_STARTED: marker } }
  const layers = [...globalStandardLayers(undefined, homeDir), ...projectStandardLayers(root)]
  for (const layer of layers) {
    mkdirSync(dirname(layer.path), { recursive: true })
    writeFileSync(layer.path, JSON.stringify({ mcpServers: { svc: def, alias: def } }))
  }
  const config = createConfigService({ storageDir, homeDir, workspaceResolver: { resolve: (id) => id === 'ws' ? { root } : undefined } })
  const supervisor = createEngineSupervisor({ storageDir }, quiet)
  const first = agentContext(), second = agentContext(), restored = agentContext(), fresh = agentContext()
  let runtime
  t.after(async () => {
    for (const ctx of [first, second, restored, fresh]) ctx.dispose()
    await runtime?.settleReleases()
    await supervisor.dispose()
    rmSync(dir, { recursive: true, force: true })
  })
  await supervisor.ensure()
  runtime = createSessionRuntime({ supervisor, config, storageDir, logger: quiet, ensureTimeoutMs: 5000, toolCallTimeoutMs: 5000 })
  await runtime.install(first, 'one', 'ws')
  await runtime.install(second, 'two', 'ws')
  assert.deepEqual(first.registered.map((tool) => tool.name).sort(), ['mcp__alias__echo', 'mcp__svc__echo'])
  assert.equal((await supervisor.request('engine.status')).mcps.length, 1, 'identical definitions in all files/aliases/sessions share one child')
  const frozen = (await readSessionFile(sessionFilePath(storageDir, 'one'))).file.snapshot
  const tool = first.registered.find((tool) => tool.name === 'mcp__svc__echo')
  const other = second.registered.find((tool) => tool.name === 'mcp__svc__echo')
  await assert.rejects(() => within(tool.execute({ msg: 'pre-aborted' }, { signal: AbortSignal.abort() })), (e) => e.code === 'E_CANCELLED')
  const controller = new AbortController()
  // Capture rejection immediately, even if a marker wait later fails.
  const settled = within(tool.execute({ msg: 'slow', delayMs: 1000 }, { signal: controller.signal })).then(() => ({ code: 'UNEXPECTED_SUCCESS' }), (error) => error)
  await within((async () => {
    const deadline = Date.now() + 3000
    while (!existsSync(marker)) {
      if (Date.now() > deadline) throw new Error('slow tool did not start')
      await new Promise((r) => setTimeout(r, 20))
    }
  })())
  controller.abort()
  assert.equal((await settled).code, 'E_CANCELLED', 'registered tool forwards exec.signal and settles locally')
  assert.equal((await within(tool.execute({ msg: 'next-step' }, {}))).content[0].text, 'next-step:old')
  assert.equal((await within(other.execute({ msg: 'other-session' }, {}))).content[0].text, 'other-session:old')
  // The slow fixture still replies after cancellation; a later request remains usable.
  await new Promise((r) => setTimeout(r, 1100))
  assert.equal((await within(tool.execute({ msg: 'after-late-reply' }, {}))).content[0].text, 'after-late-reply:old')

  const agents = layers.find((l) => l.layerId === 'project:agents')
  writeFileSync(agents.path, JSON.stringify({ mcpServers: { svc: { ...def, env: { ...def.env, MCP_TEST_GENERATION: 'new' } }, alias: def } }))
  assert.equal((await within(tool.execute({ msg: 'still-frozen' }, {}))).content[0].text, 'still-frozen:old')
  assert.equal((await runtime.install(restored, 'one', 'ws')).restored, true)
  assert.deepEqual((await readSessionFile(sessionFilePath(storageDir, 'one'))).file.snapshot, frozen, 'new sources never rewrite an existing snapshot')
  await runtime.install(fresh, 'three', 'ws')
  const newTool = fresh.registered.find((tool) => tool.name === 'mcp__svc__echo')
  assert.equal((await within(newTool.execute({ msg: 'new-session' }, {}))).content[0].text, 'new-session:new')
})

test('failed setup still continues the real agent-id waterfall exactly once, on every step', { timeout: 10000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-waterfall-'))
  const handlers = new Map(), cleanup = [], errors = []
  const host = { logger: { ...quiet, error: (line) => errors.push(line) }, on: (event, fn) => { handlers.set(event, fn); return () => handlers.delete(event) }, effect: (fn) => { cleanup.push(fn()); return () => {} } }
  const config = { preview: async () => { throw new Error('broken config fixture') } }
  publishRuntime({ engine: { request: async () => { throw new Error('no engine RPC expected') } }, config, storageDir: dir, workspaceIdFor: () => 'ws' })
  t.after(() => { for (const fn of cleanup) fn?.(); publishRuntime(undefined); rmSync(dir, { recursive: true, force: true }) })
  assert.equal(mountAgentPlane(host), true)
  const ctx = agentContext()
  handlers.get('agent/created')({ agent: { id: 'broken', ctx, session: { header: { cwd: dir } } } })
  const decision = { kind: 'enter', messages: [] }
  let calls = 0
  for (let i = 0; i < 2; i++) assert.equal(await within(handlers.get('agent/pre-step')({ agent: { id: 'broken' } }, () => { calls++; return decision })), decision)
  assert.equal(calls, 2, 'next invoked once per step, even after registration failure')
  assert.ok(errors.some((line) => line.includes('broken config fixture')))
})

test('real agent rounds keep frozen tools; new and recreated contexts cannot drift or release each other', { timeout: 30000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-turn-freeze-'))
  const storageDir = join(dir, 'store'), root = join(dir, 'ws'), globalFile = join(dir, 'global.json')
  mkdirSync(root)
  const def = { command: process.execPath, args: [fileURLToPath(new URL('./fixtures/slow-mcp.mjs', import.meta.url))] }
  writeFileSync(globalFile, JSON.stringify({ mcpServers: { original: def } }))
  const config = createConfigService({ storageDir, globalFile, workspaceResolver: { resolve: id => id === 'ws' ? { root } : undefined } })
  const supervisor = createEngineSupervisor({ storageDir }, quiet)
  const handlers = new Map(), cleanup = []
  const host = { logger: quiet, on: (name, fn) => { handlers.set(name, fn); return () => handlers.delete(name) }, effect: fn => { cleanup.push(fn()); return () => {} } }
  const old = agentContext(), replacement = agentContext(), fresh = agentContext()
  t.after(async () => {
    for (const ctx of [old, replacement, fresh]) ctx.dispose()
    for (const fn of cleanup) fn?.()
    publishRuntime(undefined)
    await supervisor.dispose()
    rmSync(dir, { recursive: true, force: true })
  })
  await supervisor.ensure()
  publishRuntime({ engine: supervisor, config, storageDir, workspaceIdFor: () => 'ws' })
  assert.equal(mountAgentPlane(host), true)
  const created = (id, ctx) => handlers.get('agent/created')({ agent: { id, ctx, session: { header: { cwd: root } } } })
  const decision = { kind: 'enter', messages: [] }
  const step = (id, ctx) => within(handlers.get('agent/pre-step')({ agent: { id, ctx } }, () => decision))
  created('existing', old)
  assert.equal(await step('existing', old), decision)
  const descriptor = old.registered[0]
  const catalog = old.registered.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))
  const snapshot = (await readSessionFile(sessionFilePath(storageDir, 'existing'))).file.snapshot
  writeFileSync(globalFile, JSON.stringify({ mcpServers: { added: { ...def, env: { MCP_TEST_GENERATION: 'new' } } } }))
  for (let round = 0; round < 3; round++) {
    created('existing', old)
    assert.equal(await step('existing', old), decision)
    assert.equal(old.registered[0], descriptor, 'later rounds never re-register the same context')
    assert.deepEqual(old.registered.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })), catalog)
    await config.preview({ workspaceId: 'ws' }) // settings/page reads are not installs
    assert.equal((await within(descriptor.execute({ msg: 'round' }, {}))).content[0].text, 'round:old')
  }
  assert.deepEqual((await readSessionFile(sessionFilePath(storageDir, 'existing'))).file.snapshot, snapshot)
  created('brand-new', fresh)
  assert.equal(await step('brand-new', fresh), decision)
  assert.deepEqual(fresh.registered.map(tool => tool.name), ['mcp__added__echo'])
  assert.equal((await within(fresh.registered[0].execute({ msg: 'new' }, {}))).content[0].text, 'new:new')
  // A -> B -> duplicate A: both contexts keep exactly one OLD descriptor.
  created('existing', replacement)
  assert.equal(await step('existing', replacement), decision)
  created('existing', old)
  assert.equal(await step('existing', old), decision)
  assert.deepEqual(replacement.registered.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })), catalog)
  assert.equal(old.registered.length, 1)
  old.dispose()
  assert.equal(await step('existing', replacement), decision)
  assert.equal((await within(replacement.registered[0].execute({ msg: 'after-old-disposal' }, {}))).content[0].text, 'after-old-disposal:old')
})
