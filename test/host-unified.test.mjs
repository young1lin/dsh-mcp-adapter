/**
 * Unified host activation (src/host/unified.ts): the engine comes up, the
 * bridge mounts, and — the part that was missing — the SESSION TOOL PLANE is
 * mounted on the host itself.
 *
 * Why this file exists: in engine mode `apply()` returns before the legacy
 * `agent/created` hook, so for a while nothing anywhere registered a session's
 * MCP tools unless the operator had hand-authored an agent-preset directory
 * carrying the `dsh-mcp-json-adapter/agent` row. The host logged "private
 * engine ready" and every session ran with zero MCP tools. Nothing failed;
 * there was simply no listener. That is only observable as "which listeners
 * exist after activation", so that is what these tests assert.
 *
 * The supervisor is injected (startUnifiedHost's third parameter) so no engine
 * child is spawned here — the wiring is the subject, not the engine.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MCP_GATEWAY_MASTER_KEY = 'ef'.repeat(32)

const distRoot = new URL((process.env.MCP_AGENT_DIST ?? '../dist') + '/', import.meta.url)
const fromDist = (path) => import(new URL(path, distRoot).href)

const { startUnifiedHost } = await fromDist('host/unified.js')
const { validateConfig } = await fromDist('config.js')
const { publishRuntime, sharedRuntime } = await fromDist('runtime/engine-shared.js')
const { fallbackWorkspaceId } = await fromDist('runtime/session-runtime.js')

/** A host context recording every listener and injection the plugin makes. */
function fakeHostContext() {
  const handlers = new Map()
  const disposers = []
  return {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    get: () => undefined,
    on: (event, listener) => { handlers.set(event, listener); return () => handlers.delete(event) },
    effect: (register) => { disposers.push(register()); return () => {} },
    // No webServer service in this composition: the bridge is optional and
    // its absence must not take the tool plane down with it.
    inject: () => undefined,
    handlers,
    dispose: () => { for (const d of disposers.splice(0)) if (typeof d === 'function') d() },
  }
}

/** An engine supervisor that answers `ensure` and nothing else. */
function fakeSupervisor() {
  return {
    ensure: async () => ({ pid: 4242 }),
    dispose: async () => {},
    request: async () => { throw new Error('the wiring test never talks to an engine') },
  }
}

/**
 * Activate the unified host against a scratch storage dir.
 * @param t - the running test, for cleanup registration.
 * @param engineBlock - the `engine` config block under test.
 * @returns the fake host context the plugin mounted on.
 */
async function activate(t, engineBlock, storedListener) {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-unified-'))
  const storageDir = join(dir, 'store')
  if (storedListener !== undefined) {
    mkdirSync(storageDir)
    writeFileSync(join(storageDir, 'listener.json'), JSON.stringify(storedListener))
  }
  const resolved = validateConfig({ engine: { storageDir, ...engineBlock }, globalFile: join(dir, 'agents.json') })
  const ctx = fakeHostContext()
  t.after(() => {
    ctx.dispose()
    publishRuntime(undefined) // module singleton: a leak fails the NEXT activation
    rmSync(dir, { recursive: true, force: true })
  })
  await startUnifiedHost(ctx, resolved, (options) => {
    ctx.spawnOptions = options
    return fakeSupervisor()
  })
  return ctx
}

test('unified host: activation mounts the session tool plane, so tools do not depend on a hand-authored preset', async (t) => {
  const ctx = await activate(t, {})
  assert.ok(ctx.handlers.has('agent/created'), 'the per-session registration barrier is armed')
  assert.ok(ctx.handlers.has('agent/pre-step'), 'the awaited step barrier is armed')
})

test('unified host: the mounted barrier continues the agent loop waterfall untouched', async (t) => {
  const ctx = await activate(t, {})
  // Same contract as the preset row: pre-step GATES a step, it never decides
  // one. A host mount that got this wrong would break every conversation in
  // the app rather than only the MCP part of it.
  const decision = { kind: 'enter', messages: [] }
  const out = await ctx.handlers.get('agent/pre-step')({ sessionId: 'no-such-session' }, () => decision)
  assert.deepEqual(out, decision)
})

test('unified host: engine.sessionTools false disables the optional session plane', async (t) => {
  const ctx = await activate(t, { sessionTools: false })
  assert.equal(ctx.handlers.has('agent/created'), false, 'no host-mounted registration barrier')
  assert.equal(ctx.handlers.has('agent/pre-step'), false, 'no host-mounted step barrier')
})

test('unified host: legacy config and persisted listener settings cannot publish HTTP', async (t) => {
  const ctx = await activate(t, { publicMcp: true, httpPort: 23456 }, { enabled: true, port: 22345 })
  assert.equal(ctx.spawnOptions.publicMcp, false)
  assert.equal(ctx.spawnOptions.httpPort, 0)
  assert.ok(ctx.handlers.has('agent/created'), 'session tools still mount')
})

test('unified host: legacy persisted listener alone cannot publish HTTP', async (t) => {
  const ctx = await activate(t, {}, { enabled: true, port: 22345 })
  assert.equal(ctx.spawnOptions.publicMcp, false)
  assert.equal(ctx.spawnOptions.httpPort, 0)
})

test('unified host: a second activation in one process is refused instead of doubling the engine', async (t) => {
  await activate(t, {})
  const dir = mkdtempSync(join(tmpdir(), 'mcp-unified-'))
  const resolved = validateConfig({ engine: { storageDir: join(dir, 'store') } })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  await assert.rejects(
    () => startUnifiedHost(fakeHostContext(), resolved, () => fakeSupervisor()),
    /already active/,
  )
})

test('unified host: a session whose cwd the host registry cannot name still resolves its scope', async (t) => {
  // With no workspaceRegistry service (this composition has none), the runtime
  // identifies a session by an id that ENCODES its cwd. The browser's resolver
  // refuses such an id on purpose — an id must never be read as a path there —
  // so handing it the same service threw `unknown workspace` out of preview and
  // the session lost EVERY entry, including the global ones that need no
  // workspace at all. The session plane gets its own resolver for exactly this.
  const ctx = await activate(t, {})
  void ctx
  const runtime = sharedRuntime()
  assert.ok(runtime !== undefined, 'the host published its runtime')
  const cwd = mkdtempSync(join(tmpdir(), 'mcp-unified-ws-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const preview = await runtime.config.preview({ workspaceId: fallbackWorkspaceId(cwd), maskSecrets: false })
  assert.ok(Array.isArray(preview.entries), 'preview resolved instead of throwing SCOPE')
  assert.ok(preview.layers.some((l) => l.level === 'project'), 'the cwd it encoded came back as the project layer')
})
