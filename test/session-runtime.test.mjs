/**
 * Session-runtime unit/regression suite (docs/progress-review.md R2/R3) —
 * fully INJECTABLE: a fake supervisor (records every engine RPC and models
 * mcp.ensure's updateDef-on-same-name behavior, the exact mutation R2 is
 * about), a fake config service, and fake agent scopes. No engine child, no
 * real user data; the real-engine integration regressions live in
 * test/agent-entry.test.mjs.
 *
 * The import root defaults to ../dist (the shared suite build) and can be
 * pointed at a scratch build via MCP_AGENT_DIST for isolated verification.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MCP_GATEWAY_MASTER_KEY = 'cd'.repeat(32)

const distRoot = new URL((process.env.MCP_AGENT_DIST ?? '../dist') + '/', import.meta.url)
const fromDist = (path) => import(new URL(path, distRoot).href)

const { instanceNameFor, createSessionRuntime } = await fromDist('runtime/session-runtime.js')
const { readSessionFile, writeSessionFile, sessionFilePath, isRestorableSnapshot } = await fromDist('config/session-store.js')

// --- fakes ---------------------------------------------------------------------------------------

/** Records every request; models the engine semantics the runtime depends on. */
function fakeSupervisor({ preExisting = [], toolsOf = () => [], supportRelease = false, failEnsureFor = [] } = {}) {
  const calls = []
  const instances = new Map() // name -> { def, lifecycle, restarts }
  for (const row of preExisting) instances.set(row.name, { def: row.def, lifecycle: row.lifecycle ?? 'started', restarts: 0 })
  const released = []
  return {
    calls,
    instances,
    released,
    async request(method, params) {
      calls.push({ method, params })
      if (method === 'engine.status') {
        return { mcps: [...instances].map(([name, v]) => ({ name, lifecycle: v.lifecycle })) }
      }
      if (method === 'mcp.ensure') {
        const name = params.name
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test(name)) throw new Error('mcp.ensure: invalid name')
        if (failEnsureFor.includes(name)) return { name, lifecycle: 'error', reason: 'broken generation' }
        // The engine's core rule (ipc-service mcp.ensure): ONE instance per
        // DEFINITION — an identical def hosted under any name answers with
        // that name, and the caller must address the reply's name.
        const fingerprint = JSON.stringify(params.def)
        const twin = [...instances].find(([n, v]) => n !== name && JSON.stringify(v.def) === fingerprint)
        if (twin !== undefined) {
          return { name: twin[0], lifecycle: twin[1].lifecycle, state: twin[1].lifecycle, reused: true }
        }
        const existing = instances.get(name)
        if (existing !== undefined) {
          // The engine's real behavior on ensure-over-existing: updateDef —
          // stop the old instance and REPLACE its definition.
          existing.def = params.def
          existing.restarts += 1
        } else {
          instances.set(name, { def: params.def, lifecycle: params.start === false ? 'stopped' : 'started', restarts: 0 })
        }
        const entry = instances.get(name)
        return { name, lifecycle: entry.lifecycle, state: entry.lifecycle }
      }
      if (method === 'mcp.tools') {
        const entry = instances.get(params.name)
        if (entry === undefined) throw new Error('unknown MCP: ' + params.name)
        return { tools: toolsOf(entry), nextCursor: undefined, total: 0 }
      }
      if (method === 'mcp.call') {
        const entry = instances.get(params.name)
        if (entry === undefined) throw new Error('unknown MCP: ' + params.name)
        return { ok: true, isError: false, content: [{ type: 'text', text: 'echo:' + String(params.arguments?.msg ?? '') }] }
      }
      if (method === 'mcp.release') {
        if (!supportRelease) {
          throw Object.assign(new Error('unknown method: mcp.release'), { code: 'E_UNKNOWN_METHOD' })
        }
        if (!instances.has(params.name)) throw new Error('unknown MCP: ' + params.name)
        instances.delete(params.name)
        released.push(params.name)
        return { released: params.name }
      }
      if (method === 'mcp.remove') {
        if (!instances.has(params.name)) throw new Error('unknown MCP: ' + params.name)
        instances.delete(params.name)
        return { removed: params.name }
      }
      throw Object.assign(new Error('unknown method: ' + method), { code: 'E_UNKNOWN_METHOD' })
    },
  }
}

/** Preview with one native echo server per given def. */
function fakeConfig(entries) {
  let current = entries
  return {
    // Models the real service's scope behavior: without a workspaceId only
    // the GLOBAL layer is visible (project layers need a workspace).
    preview: async (input = {}) => {
      const visible = input.workspaceId === undefined ? current.filter((e) => e.level === 'global') : current
      return { layers: [], entries: visible.map((e) => ({ ...e, def: e.def })), conflicts: [], problems: [] }
    },
    setEntries(next) { current = next },
  }
}

const echoEntry = (name, def, revision = 'r1') => ({ name, level: 'project', source: 'native', def, inherited: false, overrides: [], disabled: false, revision })

function fakeAgentContext() {
  const tools = []
  const disposers = []
  return {
    tools: { register: (tool) => { tools.push(tool); return () => { const i = tools.indexOf(tool); if (i >= 0) tools.splice(i, 1) } } },
    effect: (register) => { disposers.push(register()); return () => {} },
    get registered() { return tools },
    dispose: () => { for (const d of disposers.splice(0)) if (typeof d === 'function') d() },
  }
}

const quietLogger = { info: () => {}, warn: () => {}, error: (m) => console.error('[error]', m) }

function makeRuntime(supervisor, config, storageDir) {
  return createSessionRuntime({ supervisor, config, storageDir, logger: quietLogger })
}

function scratch() {
  return mkdtempSync(join(tmpdir(), 'mcp-sessionrt-'))
}

// --- tests ---------------------------------------------------------------------------------------

test('instanceNameFor: unique per workspace/def, stable otherwise, engine-legal', () => {
  const defA = { type: 'echo', description: 'A' }
  const nameRegex = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/
  const wsA = instanceNameFor('C:\ws\a', 'audit', defA)
  const wsA2 = instanceNameFor('C:\ws\a', 'audit', defA)
  const wsB = instanceNameFor('C:\ws\b', 'audit', defA)
  const defB = { type: 'echo', description: 'B' }
  const wsAdefB = instanceNameFor('C:\ws\a', 'audit', defB)
  assert.match(wsA, nameRegex)
  assert.equal(wsA, wsA2, 'deterministic for the same identity')
  assert.notEqual(wsA, wsB, 'same logical name in two workspaces -> two instances')
  assert.notEqual(wsA, wsAdefB, 'a def change mints a new generation')
  assert.notEqual(wsA, 'audit', 'the bare logical name is never the engine name')
  // key-order insensitivity: the same def with reordered keys shares one instance
  const reordered = { description: 'A', type: 'echo' }
  assert.equal(wsA, instanceNameFor('C:\ws\a', 'audit', reordered))
  // long/odd logical names stay within the engine's 63-char rule
  const odd = instanceNameFor('w', 'x'.repeat(100) + ' ä', defA)
  assert.ok(odd.length <= 63 && nameRegex.test(odd))
})

test('R2: same logical name in two workspaces never shares or mutates one instance', async () => {
  const dir = scratch()
  try {
    const defA = { type: 'echo', description: 'workspace-A' }
    const defB = { type: 'echo', description: 'workspace-B' }
    const supervisor = fakeSupervisor()
    const config = fakeConfig([echoEntry('audit_shared', defA)])
    const runtime = makeRuntime(supervisor, config, dir)

    const agentA = fakeAgentContext()
    await runtime.install(agentA, 'sess-a', 'C:\ws\a')

    // now workspace B resolves the SAME logical name to a different def
    config.setEntries([echoEntry('audit_shared', defB)])
    const agentB = fakeAgentContext()
    await runtime.install(agentB, 'sess-b', 'C:\ws\b')

    const ensured = supervisor.calls.filter((c) => c.method === 'mcp.ensure')
    assert.equal(ensured.length, 2, 'one ensure per generation')
    const names = ensured.map((c) => c.params.name)
    assert.notEqual(names[0], names[1])
    for (const name of names) {
      assert.notEqual(name, 'audit_shared', 'engine name is minted, not the logical name')
    }
    // the R2 regression: A's instance still runs A's def — B's ensure never
    // routed through updateDef under A's instance (and the bare name was
    // never addressed).
    const entryA = supervisor.instances.get(names[0])
    assert.equal(entryA.def.description, 'workspace-A')
    assert.equal(entryA.restarts, 0, "A's instance was never stopped-and-replaced")
    assert.equal(supervisor.instances.size, 2, 'two isolated generations live side by side')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('fresh install registers tools, persists a restorable v2 snapshot, releases on scope death', async () => {
  const dir = scratch()
  try {
    const def = { type: 'echo', description: 'demo' }
    const supervisor = fakeSupervisor({ toolsOf: () => [{ name: 'echo', description: 'repeat', inputSchema: { type: 'object' } }] })
    const config = fakeConfig([echoEntry('demo', def)])
    const runtime = makeRuntime(supervisor, config, dir)

    const agent = fakeAgentContext()
    const summary = await runtime.install(agent, 'sess-1', 'C:\ws\a')
    assert.equal(summary.restored, false)
    assert.equal(summary.servers, 1)
    assert.deepEqual(summary.unavailable, [])
    assert.ok(agent.registered.some((t) => t.name === 'mcp__demo__echo'), 'tool registered in the agent scope')

    // live call addressed by the INSTANCE name
    const tool = agent.registered.find((t) => t.name === 'mcp__demo__echo')
    const out = await tool.execute({ msg: 'hi' }, {})
    assert.ok(out.content.some((b) => b.text === 'echo:hi'))
    const call = supervisor.calls.find((c) => c.method === 'mcp.call')
    assert.ok(call, 'executor called through the engine')
    assert.notEqual(call.params.name, 'demo', 'mcp.call addresses the instance name')

    // snapshot: sealed file, v2, def + schemas + instance name
    const { file, problem } = await readSessionFile(sessionFilePath(dir, 'sess-1'))
    assert.equal(problem, undefined)
    assert.ok(isRestorableSnapshot(file.snapshot), 'v2 restorable snapshot persisted')
    const server = file.snapshot.servers.find((s) => s.logical === 'demo')
    assert.ok(server, 'server frozen by logical name')
    assert.deepEqual(server.def, def, 'effective def frozen')
    assert.ok(server.tools.some((t) => t.name === 'echo' && t.inputSchema !== undefined), 'tool schema frozen')
    assert.equal(server.instance, supervisor.calls.find((c) => c.method === 'mcp.ensure').params.name)

    // cleanup: scope death releases the instance (mcp.remove fallback; the
    // fake engine has no mcp.release)
    agent.dispose()
    await runtime.settleReleases()
    assert.equal(supervisor.instances.size, 0, 'own instance released with the session')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('release prefers the dedicated mcp.release RPC when the engine serves it', async () => {
  const dir = scratch()
  try {
    const supervisor = fakeSupervisor({ supportRelease: true, toolsOf: () => [] })
    const config = fakeConfig([echoEntry('demo', { type: 'echo' })])
    const runtime = makeRuntime(supervisor, config, dir)
    const agent = fakeAgentContext()
    await runtime.install(agent, 'sess-r', 'C:\ws\a')
    agent.dispose()
    await runtime.settleReleases()
    assert.deepEqual(supervisor.released, supervisor.calls.filter((c) => c.method === 'mcp.ensure').map((c) => c.params.name))
    assert.equal(supervisor.calls.filter((c) => c.method === 'mcp.remove').length, 0, 'fallback not used when release exists')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('same workspace+def sessions share one instance; last lease out releases it', async () => {
  const dir = scratch()
  try {
    const def = { type: 'echo', description: 'shared' }
    const supervisor = fakeSupervisor({ toolsOf: () => [{ name: 'echo' }] })
    const config = fakeConfig([echoEntry('demo', def)])
    const runtime = makeRuntime(supervisor, config, dir)

    const agent1 = fakeAgentContext()
    await runtime.install(agent1, 'sess-1', 'C:\ws\a')
    const agent2 = fakeAgentContext()
    await runtime.install(agent2, 'sess-2', 'C:\ws\a')

    assert.equal(supervisor.calls.filter((c) => c.method === 'mcp.ensure').length, 1, 'second session REUSES the live instance (no updateDef)')

    agent1.dispose()
    await runtime.settleReleases()
    assert.equal(supervisor.instances.size, 1, 'a live co-owner keeps the instance')

    agent2.dispose()
    await runtime.settleReleases()
    assert.equal(supervisor.instances.size, 0, 'last lease out releases the instance')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('R3: a re-appearing session restores its frozen generation, not the current preview', async () => {
  const dir = scratch()
  try {
    const defV1 = { type: 'echo', description: 'generation-1' }
    const supervisor = fakeSupervisor({ toolsOf: () => [{ name: 'echo', description: 'repeat', inputSchema: { type: 'object' } }] })
    const config = fakeConfig([echoEntry('demo', defV1, 'rev-1')])
    const runtime = makeRuntime(supervisor, config, dir)
    const agent = fakeAgentContext()
    await runtime.install(agent, 'sess-42', 'C:\ws\a')
    agent.dispose() // session ends; instance released
    await runtime.settleReleases()

    const { file } = await readSessionFile(sessionFilePath(dir, 'sess-42'))
    const frozen = file.snapshot
    const frozenInstance = frozen.servers[0].instance

    // host restart: new engine (empty), config moved on to a different def
    const defV2 = { type: 'echo', description: 'generation-2' }
    const supervisor2 = fakeSupervisor({ toolsOf: () => [{ name: 'brand_new_tool' }] })
    const config2 = fakeConfig([echoEntry('demo', defV2, 'rev-2')])
    const runtime2 = makeRuntime(supervisor2, config2, dir)

    const agent2 = fakeAgentContext()
    const summary = await runtime2.install(agent2, 'sess-42', 'C:\ws\a')
    assert.equal(summary.restored, true, 'snapshot replayed')

    const ensured = supervisor2.calls.filter((c) => c.method === 'mcp.ensure')
    assert.equal(ensured.length, 1)
    assert.equal(ensured[0].params.name, frozenInstance, 'restored under the frozen instance name')
    assert.equal(ensured[0].params.def.description, 'generation-1', 'restored from the FROZEN def, not the current preview')
    assert.equal(supervisor2.instances.get(frozenInstance).def.description, 'generation-1')

    // tool schemas come from the snapshot, not the live server (which would
    // answer brand_new_tool now)
    assert.ok(agent2.registered.some((t) => t.name === 'mcp__demo__echo'), 'frozen tool re-registered')
    assert.ok(!agent2.registered.some((t) => t.name === 'mcp__demo__brand_new_tool'), 'no schema drift into the session')

    // immutability: the re-install did not rewrite the frozen generation
    const { file: after } = await readSessionFile(sessionFilePath(dir, 'sess-42'))
    assert.equal(after.snapshot.registeredAt, frozen.registeredAt)
    assert.equal(after.snapshot.configRevision, frozen.configRevision)
    assert.deepEqual(after.snapshot.servers, frozen.servers)

    agent2.dispose()
    await runtime2.settleReleases()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('R3: an un-restorable generation is reported unavailable, never substituted with current config', async () => {
  const dir = scratch()
  try {
    const defV1 = { type: 'echo', description: 'generation-1' }
    const supervisor = fakeSupervisor({ toolsOf: () => [{ name: 'echo' }] })
    const config = fakeConfig([echoEntry('demo', defV1)])
    const runtime = makeRuntime(supervisor, config, dir)
    const agent = fakeAgentContext()
    await runtime.install(agent, 'sess-broken', 'C:\ws\a')
    agent.dispose()
    await runtime.settleReleases()

    const { file } = await readSessionFile(sessionFilePath(dir, 'sess-broken'))
    const frozenInstance = file.snapshot.servers[0].instance

    // restart where the frozen generation cannot come back, while the
    // current preview offers a perfectly healthy NEW def
    const supervisor2 = fakeSupervisor({ failEnsureFor: [frozenInstance], toolsOf: () => [{ name: 'echo' }] })
    const config2 = fakeConfig([echoEntry('demo', { type: 'echo', description: 'healthy-new-def' })])
    const runtime2 = makeRuntime(supervisor2, config2, dir)

    const agent2 = fakeAgentContext()
    const summary = await runtime2.install(agent2, 'sess-broken', 'C:\ws\a')
    assert.equal(summary.restored, true)
    assert.deepEqual(summary.unavailable, ['demo'])
    assert.equal(agent2.registered.length, 0, 'no tools smuggled in from the current preview')
    assert.equal(supervisor2.calls.filter((c) => c.method === 'mcp.ensure').length, 1, 'only the frozen instance was attempted')

    // the snapshot is not rewritten by the failure
    const { file: after } = await readSessionFile(sessionFilePath(dir, 'sess-broken'))
    assert.equal(after.snapshot.registeredAt, file.snapshot.registeredAt)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('legacy v1 snapshots stay readable, recompute once, and upgrade to v2', async () => {
  const dir = scratch()
  try {
    const path = sessionFilePath(dir, 'sess-legacy')
    await writeSessionFile(path, { schemaVersion: 1, overrides: {}, snapshot: { revision: 'deadbeef', registeredAt: '2020-01-01T00:00:00.000Z', tools: ['mcp__demo__echo'] } })

    const supervisor = fakeSupervisor({ toolsOf: () => [{ name: 'echo' }] })
    const config = fakeConfig([echoEntry('demo', { type: 'echo' })])
    const runtime = makeRuntime(supervisor, config, dir)
    const agent = fakeAgentContext()
    const summary = await runtime.install(agent, 'sess-legacy', 'C:\ws\a')
    assert.equal(summary.restored, false, 'v1 is not restorable — recomputed from the preview')
    const { file } = await readSessionFile(path)
    assert.ok(isRestorableSnapshot(file.snapshot), 'file upgraded to a restorable v2 snapshot')
    agent.dispose()
    await runtime.settleReleases()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a pre-existing engine server under the bare logical name is never touched', async () => {
  const dir = scratch()
  try {
    const foreignDef = { type: 'echo', description: 'someone else configured this' }
    const supervisor = fakeSupervisor({ preExisting: [{ name: 'demo', def: foreignDef }], toolsOf: () => [{ name: 'echo' }] })
    const config = fakeConfig([echoEntry('demo', { type: 'echo', description: 'mine' })])
    const runtime = makeRuntime(supervisor, config, dir)

    const agent = fakeAgentContext()
    await runtime.install(agent, 'sess-x', 'C:\ws\a')
    agent.dispose()
    await runtime.settleReleases()

    const touched = supervisor.calls.filter((c) => /demo$/.test(String(c.params?.name ?? '')) && c.params?.name === 'demo')
    assert.equal(touched.length, 0, 'no RPC ever addressed the bare logical name')
    assert.equal(supervisor.instances.get('demo').def.description, 'someone else configured this', 'foreign instance untouched')
    assert.ok(supervisor.instances.has('demo'), 'foreign instance still alive')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('standard entries convert to the engine dialect before ensuring', async () => {
  const dir = scratch()
  try {
    const supervisor = fakeSupervisor({ toolsOf: () => [{ name: 'echo' }] })
    const config = fakeConfig([{ name: 'local', level: 'project', source: 'standard', def: { command: 'node -e ""' }, inherited: false, overrides: [], disabled: false, revision: 'r1' }])
    const runtime = makeRuntime(supervisor, config, dir)
    const agent = fakeAgentContext()
    await runtime.install(agent, 'sess-std', 'C:\ws\a')
    const ensured = supervisor.calls.find((c) => c.method === 'mcp.ensure')
    assert.ok(ensured, 'ensured')
    assert.equal(ensured.params.def.type, 'proc', 'standard command converted to the engine proc dialect (data, not executed here)')
    agent.dispose()
    await runtime.settleReleases()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- warm install cache + prewarm (DSH 0.1.5 assemble-before-pre-step) ---------------------------

const globalEcho = (name, def, revision = 'r1') => ({ name, level: 'global', source: 'native', def, inherited: false, overrides: [], disabled: false, revision })

test('warm cache: a second session with the same def registers with zero engine round trips', async () => {
  const dir = scratch()
  try {
    const def = { type: 'echo', description: 'warm' }
    const supervisor = fakeSupervisor({ toolsOf: () => [{ name: 'echo', inputSchema: { type: 'object' } }] })
    const config = fakeConfig([echoEntry('demo', def)])
    const runtime = makeRuntime(supervisor, config, dir)

    const a = fakeAgentContext()
    const first = await runtime.install(a, 'sess-w1', 'C:\ws\a')
    const before = supervisor.calls.length
    assert.equal(first.tools, 1)

    // A DIFFERENT workspace, the SAME definition: one def, one instance —
    // and now one cache hit, so not even engine.status is asked.
    const b = fakeAgentContext()
    const second = await runtime.install(b, 'sess-w2', 'C:\ws\b')
    assert.equal(second.tools, 1)
    assert.equal(supervisor.calls.length, before, 'cache hit: no status/ensure/tools RPC for the second session')

    a.dispose()
    b.dispose()
    await runtime.settleReleases()
    assert.equal(supervisor.instances.size, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('warm cache invalidates when the engine epoch changes (engine respawned)', async () => {
  const dir = scratch()
  try {
    const def = { type: 'echo', description: 'epoch' }
    const supervisor = fakeSupervisor({ toolsOf: () => [{ name: 'echo' }] })
    const config = fakeConfig([echoEntry('demo', def)])
    let epoch = 'pid-1'
    const runtime = createSessionRuntime({ supervisor, config, storageDir: dir, logger: quietLogger, engineEpoch: () => epoch })

    const a = fakeAgentContext()
    await runtime.install(a, 'sess-e1', 'C:\ws\a')
    assert.equal(supervisor.calls.filter((c) => c.method === 'mcp.ensure').length, 1)

    epoch = 'pid-2' // engine child replaced: every cached instance is gone
    // A DIFFERENT workspace on purpose: the same one would mint the same
    // name, and instanceUsable() finding it still "live" in the fake would
    // legitimately skip the re-ensure. A new mint must go back to the engine.
    const b = fakeAgentContext()
    await runtime.install(b, 'sess-e2', 'C:\ws\b')
    assert.equal(supervisor.calls.filter((c) => c.method === 'mcp.ensure').length, 2, 'stale epoch forces a fresh resolution')

    a.dispose()
    b.dispose()
    await runtime.settleReleases()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('warm cache drops its entry when the last lease releases the instance', async () => {
  const dir = scratch()
  try {
    const def = { type: 'echo', description: 'churn' }
    const supervisor = fakeSupervisor({ toolsOf: () => [{ name: 'echo' }] })
    const config = fakeConfig([echoEntry('demo', def)])
    const runtime = makeRuntime(supervisor, config, dir)

    const a = fakeAgentContext()
    await runtime.install(a, 'sess-c1', 'C:\ws\a')
    a.dispose()
    await runtime.settleReleases()
    assert.equal(supervisor.instances.size, 0, 'instance left with its last owner')

    // The warm entry died with the instance: the next session re-resolves
    // instead of registering tools that address a released name.
    const b = fakeAgentContext()
    const summary = await runtime.install(b, 'sess-c2', 'C:\ws\a')
    assert.equal(summary.tools, 1)
    assert.equal(supervisor.calls.filter((c) => c.method === 'mcp.ensure').length, 2, 're-ensured after release')
    b.dispose()
    await runtime.settleReleases()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('prewarmGlobal binds engine-hosted global defs; installs then ride the cache', async () => {
  const dir = scratch()
  try {
    const gDef = { type: 'echo', description: 'global' }
    // The engine already hosts this def under the panel's own name — the
    // deployment prewarm is built for (persisted store autostarts at boot).
    const supervisor = fakeSupervisor({
      preExisting: [{ name: 'panel-g1', def: gDef, lifecycle: 'started' }],
      toolsOf: () => [{ name: 'echo', inputSchema: { type: 'object' } }],
    })
    const config = fakeConfig([
      globalEcho('g1', gDef),
      echoEntry('demo', { type: 'echo', description: 'project' }),
    ])
    const runtime = makeRuntime(supervisor, config, dir)

    const warm = await runtime.prewarmGlobal()
    assert.equal(warm.servers, 1, 'only the GLOBAL entry prewarms')
    assert.equal(warm.tools, 1)
    const prewarmEnsures = supervisor.calls.filter((c) => c.method === 'mcp.ensure')
    assert.equal(prewarmEnsures.length, 1)
    assert.equal(prewarmEnsures[0].params.start, false, 'prewarm never starts anything')

    // First session of a REAL workspace: the global def is a cache hit, so
    // the only engine work left is the project layer's own entry.
    const agent = fakeAgentContext()
    const summary = await runtime.install(agent, 'sess-p1', 'C:\ws\a')
    assert.equal(summary.servers, 2)
    const ensuresAfterInstall = supervisor.calls.filter((c) => c.method === 'mcp.ensure')
    assert.equal(ensuresAfterInstall.length, 2, 'project entry ensured; global entry came from the cache')

    agent.dispose()
    await runtime.settleReleases()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('prewarm leaves the engine hosting exactly what it hosted: cold defs neither start nor stay', async () => {
  const dir = scratch()
  try {
    // No preExisting rows: the global def is COLD. Prewarm probes with
    // start:false, finds nothing live, and must clean up its own probe row.
    const supervisor = fakeSupervisor({ supportRelease: true, toolsOf: () => [{ name: 'echo' }] })
    const config = fakeConfig([globalEcho('cold', { type: 'echo', description: 'cold' })])
    const runtime = makeRuntime(supervisor, config, dir)
    const warm = await runtime.prewarmGlobal()
    assert.equal(warm.servers, 0, 'a cold def is not warmable')
    await runtime.settleReleases()
    assert.equal(supervisor.instances.size, 0, 'the probe row was released again')
    const coldMint = instanceNameFor('__prewarm__', 'cold', { type: 'echo', description: 'cold' })
    assert.ok(supervisor.released.includes(coldMint), 'the released row was prewarm own probe')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('prewarm isolates a broken global entry and keeps warming the rest', async () => {
  const dir = scratch()
  try {
    const goodDef = { type: 'echo', description: 'fine' }
    const badDef = { type: 'echo', description: 'broken' }
    // The exact name prewarm will mint for the broken entry, so the fake
    // engine can refuse just that ensure (native entry: def passes as-is).
    const brokenMint = instanceNameFor('__prewarm__', 'bad', badDef)
    const supervisor = fakeSupervisor({
      preExisting: [{ name: 'panel-good', def: goodDef, lifecycle: 'started' }],
      toolsOf: () => [{ name: 'echo' }],
      failEnsureFor: [brokenMint],
    })
    const config = fakeConfig([
      globalEcho('bad', badDef),
      globalEcho('good', goodDef),
    ])
    const runtime = makeRuntime(supervisor, config, dir)
    const warm = await runtime.prewarmGlobal()
    assert.equal(warm.servers, 1, 'the healthy entry warmed')
    assert.equal(warm.tools, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
