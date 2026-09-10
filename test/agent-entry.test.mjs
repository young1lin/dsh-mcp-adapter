/**
 * Agent-entry end-to-end (TASK P3.2/P3.3/P3.4, progress-review R2/R3): the
 * preset-row plugin mounts a session's MCP tools into the AGENT'S OWN scope
 * layer through the REAL engine child — ensure, tools list, a live tool
 * call, the sealed v2 snapshot, instance isolation across workspaces, and
 * restore-from-snapshot after the config moved on.
 *
 * The import root defaults to ../dist (the shared suite build) and can be
 * pointed at a scratch build via MCP_AGENT_DIST for isolated verification.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MCP_GATEWAY_MASTER_KEY = 'cd'.repeat(32)

const distRoot = new URL((process.env.MCP_AGENT_DIST ?? '../dist') + '/', import.meta.url)
const fromDist = (path) => import(new URL(path, distRoot).href)

const { createEngineSupervisor } = await fromDist('runtime/engine-supervisor.js')
const { publishEngine, publishRuntime } = await fromDist('runtime/engine-shared.js')
const agent = await fromDist('agent.js')
const { readSessionFile, sessionFilePath, isRestorableSnapshot } = await fromDist('config/session-store.js')

function fakeHostContext() {
  const handlers = new Map()
  const disposers = []
  return {
    logger: { info: () => {}, warn: (m) => console.error('[warn]', m), error: (m) => console.error('[error]', m) },
    on: (event, listener) => { handlers.set(event, listener); return () => handlers.delete(event) },
    effect: (register) => { disposers.push(register()); return () => {} },
    handlers,
    dispose: () => { for (const d of disposers.splice(0)) if (typeof d === 'function') d() },
  }
}

function fakeAgentContext() {
  const tools = []
  const disposers = []
  return {
    tools: {
      register: (tool) => {
        tools.push(tool)
        return () => { const i = tools.indexOf(tool); if (i >= 0) tools.splice(i, 1) }
      },
    },
    effect: (register) => { disposers.push(register()); return () => {} },
    get registered() { return tools },
    dispose: () => { for (const d of disposers.splice(0)) if (typeof d === 'function') d() },
  }
}

/**
 * Drive the `agent/pre-step` barrier the way the agent loop drives it.
 *
 * It is a cordis WATERFALL: the loop appends its own `next` as the last
 * dispatch argument and uses the OUTERMOST listener's return value as the
 * step decision (cordis events.waterfall). A listener that skips `next()`
 * therefore does not merely fail to gate the step, it replaces the loop's
 * decision — which is why this helper asserts the decision comes back
 * untouched rather than only awaiting the promise.
 * @param host - the fake host context holding the listeners.
 * @param sessionId - the session whose registration barrier to await.
 * @returns the decision the waterfall resolved to.
 */
async function preStep(host, sessionId) {
  const decision = { kind: 'enter', messages: ['sentinel'] }
  const out = await host.handlers.get('agent/pre-step')({ sessionId }, () => decision)
  assert.deepEqual(out, decision, 'pre-step must continue the waterfall, not decide it')
  return out
}

/** Poll the engine registry until pred holds (release RPCs are async). */
async function untilEngine(supervisor, pred, what, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const status = await supervisor.request('engine.status', undefined, { timeoutMs: 5000 })
    if (pred(status)) return status
    if (Date.now() > deadline) throw new Error('engine did not reach: ' + what)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

test('agent entry: engine-backed session tools register in the agent scope, snapshot, and release on scope death', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-agent-'))
  // the agent entry derives its storage root from DSH_HOME (same default as
  // the host plugin); point it at the fixture so the catalog is shared
  process.env.DSH_HOME = dir
  // isolate the agent entry's DEFAULT global standard file (~/.agents/.mcp.json
  // derives from the profile home) so the fixture never reads the real one
  const realProfile = process.env.USERPROFILE
  process.env.USERPROFILE = dir
  const storage = join(dir, 'mcp-manager') // same derivation as the agent entry
  const supervisor = createEngineSupervisor({ storageDir: storage }, { info: () => {}, warn: () => {} })
  t.after(() => {
    delete process.env.DSH_HOME
    if (realProfile !== undefined) process.env.USERPROFILE = realProfile
    // dispose BEFORE rm: the live engine child keeps writing into the
    // storage dir (ledger, state) — an rmSync racing those writes throws
    // ENOTEMPTY on POSIX, and the throw skips dispose entirely, leaking a
    // child whose pipes hold the whole test process open (the CI hang).
    return supervisor.dispose().finally(() => rmSync(dir, { recursive: true, force: true }))
  })
  await supervisor.ensure()
  publishEngine(supervisor)

  // workspace with one active standard server (echo via native def)
  const ws = join(dir, 'ws')
  mkdirSync(ws, { recursive: true })
  writeFileSync(join(ws, '.mcp.json'), JSON.stringify({ mcpServers: { echo: { command: 'node -e ""' } } }))
  // seed the native catalog with a REAL echo def so mcp.ensure has something
  const { createConfigService } = await fromDist('config/service.js')
  const svc = createConfigService({
    storageDir: storage,
    globalFile: join(dir, 'agents.json'),
    workspaceResolver: { resolve: () => ({ root: ws }) },
  })
  const p0 = await svc.preview({ workspaceId: 'ws-1' })
  const catRev = p0.layers.filter((l) => l.source === 'native')[0].revision
  await svc.saveEntry({ level: 'global', source: 'native', name: 'demo', def: { type: 'echo' }, expectedRevision: catRev })

  const host = fakeHostContext()
  await agent.apply(host, {})
  const agentCtx = fakeAgentContext()

  // barrier 1: agent/created kicks registration
  host.handlers.get('agent/created')({ agent: { id: 'sess-42', ctx: agentCtx, session: { id: 'sess-42', header: { cwd: ws } } } })
  // barrier 2: pre-step awaits it, then hands the loop its own decision back
  await preStep(host, 'sess-42')

  const names = agentCtx.registered.map((x) => x.name)
  assert.ok(names.includes('mcp__demo__echo'), 'engine tool registered in agent scope: ' + names.join(','))

  // live call through the executor
  const tool = agentCtx.registered.find((x) => x.name === 'mcp__demo__echo')
  const out = await tool.execute({ msg: 'hello agent plane' }, {})
  const text = (out.content ?? []).map((b) => b.text ?? '').join('')
  assert.ok(text.includes('hello agent plane'), 'round-trip through engine mcp.call: ' + text)

  // v2 snapshot persisted in the sealed session file (P3.4/R3): effective
  // def + tool schemas + the engine instance name it was ensured under
  const { file } = await readSessionFile(sessionFilePath(storage, 'sess-42'))
  assert.ok(isRestorableSnapshot(file.snapshot), 'restorable v2 snapshot recorded')
  const server = file.snapshot.servers.find((s) => s.logical === 'demo')
  assert.ok(server, 'server frozen by logical name')
  assert.deepEqual(server.def, { type: 'echo' })
  assert.ok(server.tools.some((x) => x.name === 'echo'), 'tool schema frozen')
  assert.notEqual(server.instance, 'demo', 'engine instance name is minted, not the logical name')

  // scope isolation: the tool set dies with the agent scope (P3.3) and the
  // session's OWN engine instance is released with it (R2 cleanup)
  const count = agentCtx.registered.length
  agentCtx.dispose()
  assert.equal(agentCtx.registered.length, 0, 'all tools disposed with the agent (was ' + count + ')')
  await untilEngine(supervisor, (status) => status.mcps.every((m) => m.name !== server.instance), 'own instance released')
  host.dispose()
})

test('agent entry R2: the same logical name in two workspaces stays two isolated engine instances', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-agent-'))
  process.env.DSH_HOME = dir
  const realProfile = process.env.USERPROFILE
  process.env.USERPROFILE = dir
  const storage = join(dir, 'mcp-manager')
  const supervisor = createEngineSupervisor({ storageDir: storage }, { info: () => {}, warn: () => {} })
  t.after(() => {
    publishRuntime(undefined) // do not leak this test's services into the next
    delete process.env.DSH_HOME
    if (realProfile !== undefined) process.env.USERPROFILE = realProfile
    // dispose BEFORE rm (see the note above): an rmSync racing the live
    // engine's writes throws ENOTEMPTY and skips dispose, leaking a child.
    return supervisor.dispose().finally(() => rmSync(dir, { recursive: true, force: true }))
  })
  await supervisor.ensure()
  publishEngine(supervisor)

  // two workspaces whose native catalogs define the SAME logical name with
  // different defs — the exact R2 reproduction shape
  const { createConfigService } = await fromDist('config/service.js')
  const wsA = join(dir, 'wsA')
  const wsB = join(dir, 'wsB')
  mkdirSync(wsA, { recursive: true })
  mkdirSync(wsB, { recursive: true })
  const svcA = createConfigService({ storageDir: storage, globalFile: join(dir, 'agents.json'), workspaceResolver: { resolve: (id) => id === 'ws-a' ? { root: wsA } : { root: wsB } } })
  const pA = await svcA.preview({ workspaceId: 'ws-a' })
  const catA = pA.layers.filter((l) => l.source === 'native' && l.label === 'native:ws-a')[0].revision
  await svcA.saveEntry({ level: 'project', source: 'native', name: 'audit_shared', def: { type: 'echo', description: 'workspace-A' }, expectedRevision: catA, workspaceId: 'ws-a' })
  const pB = await svcA.preview({ workspaceId: 'ws-b' })
  const catB = pB.layers.filter((l) => l.source === 'native' && l.label === 'native:ws-b')[0].revision
  await svcA.saveEntry({ level: 'project', source: 'native', name: 'audit_shared', def: { type: 'echo', description: 'workspace-B' }, expectedRevision: catB, workspaceId: 'ws-b' })

  // Publish the PARENT contract (engine-shared SharedRuntime): canonical
  // config service + host workspace ids — the production wiring this
  // session plane is built to consume.
  publishRuntime({ engine: supervisor, config: svcA, storageDir: storage, workspaceIdFor: (cwd) => cwd === wsA ? 'ws-a' : cwd === wsB ? 'ws-b' : undefined })

  const host = fakeHostContext()
  await agent.apply(host, {})
  const agentA = fakeAgentContext()
  const agentB = fakeAgentContext()
  host.handlers.get('agent/created')({ agent: { id: 'sess-a', ctx: agentA, session: { id: 'sess-a', header: { cwd: wsA } } } })
  host.handlers.get('agent/created')({ agent: { id: 'sess-b', ctx: agentB, session: { id: 'sess-b', header: { cwd: wsB } } } })
  await preStep(host, 'sess-a')
  await preStep(host, 'sess-b')

  const status = await untilEngine(supervisor, (s) => s.mcps.length === 2, 'two isolated instances live')
  const names = status.mcps.map((m) => m.name).sort()
  assert.equal(names.length, 2, 'exactly two engine instances')
  assert.notEqual(names[0], names[1])
  for (const name of names) assert.notEqual(name, 'audit_shared', 'no instance is addressed by the bare logical name')

  // both sessions' tools stay callable side by side — neither install
  // replaced the other's connection target
  for (const [scope, label] of [[agentA, 'A'], [agentB, 'B']]) {
    const tool = scope.registered.find((x) => x.name === 'mcp__audit_shared__echo')
    assert.ok(tool, label + ' session has its tool')
    const out = await tool.execute({ msg: label }, {})
    const text = (out.content ?? []).map((b) => b.text ?? '').join('')
    assert.ok(text.includes(label), label + ' round-trip still works: ' + text)
  }

  // the two sessions' snapshots recorded the two distinct instance names
  const fileA = await readSessionFile(sessionFilePath(storage, 'sess-a'))
  const fileB = await readSessionFile(sessionFilePath(storage, 'sess-b'))
  assert.notEqual(fileA.file.snapshot.servers[0].instance, fileB.file.snapshot.servers[0].instance)

  agentA.dispose()
  agentB.dispose()
  host.dispose()
})

test('agent entry R3: a re-appearing session restores its frozen generation instead of the current preview', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-agent-'))
  process.env.DSH_HOME = dir
  const realProfile = process.env.USERPROFILE
  process.env.USERPROFILE = dir
  const storage = join(dir, 'mcp-manager')
  const supervisor = createEngineSupervisor({ storageDir: storage }, { info: () => {}, warn: () => {} })
  t.after(() => {
    delete process.env.DSH_HOME
    if (realProfile !== undefined) process.env.USERPROFILE = realProfile
    // dispose BEFORE rm: the live engine child keeps writing into the
    // storage dir (ledger, state) — an rmSync racing those writes throws
    // ENOTEMPTY on POSIX, and the throw skips dispose entirely, leaking a
    // child whose pipes hold the whole test process open (the CI hang).
    return supervisor.dispose().finally(() => rmSync(dir, { recursive: true, force: true }))
  })
  await supervisor.ensure()
  publishEngine(supervisor)

  const ws = join(dir, 'ws')
  mkdirSync(ws, { recursive: true })
  const { createConfigService } = await fromDist('config/service.js')
  const svc = createConfigService({ storageDir: storage, globalFile: join(dir, 'agents.json'), workspaceResolver: { resolve: () => ({ root: ws }) } })
  const p0 = await svc.preview({ workspaceId: 'ws-1' })
  const catRev = p0.layers.filter((l) => l.source === 'native')[0].revision
  await svc.saveEntry({ level: 'global', source: 'native', name: 'demo', def: { type: 'echo' }, expectedRevision: catRev })

  // first life of the session: registers and freezes its generation
  const host1 = fakeHostContext()
  await agent.apply(host1, {})
  const agentCtx1 = fakeAgentContext()
  host1.handlers.get('agent/created')({ agent: { id: 'sess-42', ctx: agentCtx1, session: { id: 'sess-42', header: { cwd: ws } } } })
  await preStep(host1, 'sess-42')
  assert.ok(agentCtx1.registered.some((x) => x.name === 'mcp__demo__echo'))
  const frozen = (await readSessionFile(sessionFilePath(storage, 'sess-42'))).file.snapshot
  const frozenInstance = frozen.servers[0].instance
  agentCtx1.dispose()
  await untilEngine(supervisor, (s) => s.mcps.every((m) => m.name !== frozenInstance), 'first life released its instance')
  host1.dispose()

  // the config moves on to a BROKEN def: a fresh install would fail, only
  // the frozen generation can bring the tools back
  const p1 = await svc.preview({ workspaceId: 'ws-1' })
  const catRev2 = p1.layers.filter((l) => l.source === 'native')[0].revision
  await svc.saveEntry({ level: 'global', source: 'native', name: 'demo', def: { type: 'proc', command: 'definitely-not-a-real-command-dsh-test' }, expectedRevision: catRev2 })

  // the session appears again (restore / re-mounted preset row): a NEW host
  // context, a fresh apply, the SAME session id
  const host2 = fakeHostContext()
  await agent.apply(host2, {})
  const agentCtx2 = fakeAgentContext()
  host2.handlers.get('agent/created')({ agent: { id: 'sess-42', ctx: agentCtx2, session: { id: 'sess-42', header: { cwd: ws } } } })
  await preStep(host2, 'sess-42')

  assert.ok(agentCtx2.registered.some((x) => x.name === 'mcp__demo__echo'), 'restored from the frozen generation (current preview is broken)')
  const out = await agentCtx2.registered.find((x) => x.name === 'mcp__demo__echo').execute({ msg: 'restored' }, {})
  const text = (out.content ?? []).map((b) => b.text ?? '').join('')
  assert.ok(text.includes('restored'), 'restored tool round-trips: ' + text)

  const status = await supervisor.request('engine.status', undefined, { timeoutMs: 5000 })
  assert.ok(status.mcps.some((m) => m.name === frozenInstance), 'restored under the frozen instance name')
  assert.equal(status.mcps.filter((m) => m.name !== frozenInstance).length, 0, 'no stray instance from the broken current def')

  // immutability: the second life did not rewrite the frozen generation
  const again = (await readSessionFile(sessionFilePath(storage, 'sess-42'))).file.snapshot
  assert.equal(again.registeredAt, frozen.registeredAt)
  assert.deepEqual(again.servers, frozen.servers)

  agentCtx2.dispose()
  host2.dispose()
})

test('agent entry: the pre-step barrier continues the waterfall for sessions it knows nothing about', async () => {
  // The loop dispatches pre-step for EVERY agent, including ones this plane
  // never registered (no engine, another preset, a bare session). Cordis has
  // no "not my event" return: a listener that answers with anything but
  // next()'s value hands the agent loop that value as its step decision, and
  // the loop reads decision.kind straight off it. The old listener returned
  // undefined here and threw a TypeError on every step of every session.
  const host = fakeHostContext()
  await agent.apply(host, {})
  const decision = { kind: 'reject', reason: 'from the loop' }
  const unknown = await host.handlers.get('agent/pre-step')({ sessionId: 'never-registered' }, () => decision)
  assert.deepEqual(unknown, decision, 'an unknown session gets the loop decision back untouched')
  const noId = await host.handlers.get('agent/pre-step')({}, () => decision)
  assert.deepEqual(noId, decision, 'a payload with no session id still continues the chain')
  host.dispose()
})

test('agent entry: the plane mounts once per process, whichever entry gets there first', async () => {
  // The host mounts the plane (src/host/unified.ts) AND the preset row still
  // exists. Two live mounts would register every tool twice into the same
  // agent scope and take two engine leases per session, so the second is a
  // no-op until the first one's fiber lets go.
  const first = fakeHostContext()
  assert.equal(agent.mountAgentPlane(first, {}), true, 'first mount wins')
  const second = fakeHostContext()
  assert.equal(agent.mountAgentPlane(second, {}), false, 'second mount is refused')
  assert.equal(second.handlers.size, 0, 'the refused mount registered no listeners')
  first.dispose()
  const third = fakeHostContext()
  assert.equal(agent.mountAgentPlane(third, {}), true, 'the guard re-arms when the holder disposes')
  third.dispose()
})
