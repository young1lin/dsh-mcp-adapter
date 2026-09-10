/**
 * Host bridge tests (P5): routes over a fake webServer, trust-fence
 * refusals, and a preview/save round-trip through the REAL config service.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'

process.env.MCP_GATEWAY_MASTER_KEY = '99'.repeat(32)

const { mountBridge, refusalFor } = await import('../dist/host/api.js')
const { createConfigService } = await import('../dist/config/service.js')
const { DEFAULT_MCP_PORT, applyListener, portFree, resolveListener } = await import('../dist/host/listener.js')
const { createServer } = await import('node:net')

/** Minimal req/res fakes shaped like node:http. */
function fakeReq(method, path, { host = '127.0.0.1:3080', origin, site, remote = '127.0.0.1', body } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.url = path
  req.headers = { host, ...(origin !== undefined ? { origin } : {}), ...(site !== undefined ? { 'sec-fetch-site': site } : {}) }
  req.socket = { remoteAddress: remote }
  req.body = body
  return req
}
function fakeRes() {
  const res = new EventEmitter()
  res.headersSent = false
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers }
  res.end = (text) => { res.body = text; res.headersSent = true; res.emit('done') }
  return res
}

async function handle(handler, req, res) {
  const p = handler(req, res)
  if (p !== undefined && typeof p.then === 'function') await p
  if (req.body !== undefined) {
    setImmediate(() => {
      req.emit('data', Buffer.from(JSON.stringify(req.body)))
      req.emit('end')
    })
  } else {
    // a body-less request still ends (real HTTP semantics: CL 0 or chunked end)
    setImmediate(() => req.emit('end'))
  }
  if (res.body === undefined) await new Promise((resolve) => res.once('done', resolve))
  return { status: res.status, json: JSON.parse(res.body) }
}

test('trust fence: rebinding Host, cross-origin, cross-site are refused', () => {
  assert.equal(refusalFor(fakeReq('GET', '/x', { host: 'evil.test' }), {}), 'Host must name this machine')
  assert.equal(refusalFor(fakeReq('GET', '/x', { host: 'localhost', remote: '10.0.0.5' }), {}), 'loopback Host from a non-loopback peer')
  assert.equal(refusalFor(fakeReq('GET', '/x', { origin: 'https://evil.test' }), {}), 'cross-origin Origin')
  assert.equal(refusalFor(fakeReq('GET', '/x', { site: 'cross-site' }), {}), 'cross-site fetch marker')
  assert.equal(refusalFor(fakeReq('GET', '/x', { site: 'same-origin' }), {}), undefined)
})

test('bridge: preview + save round-trip through the real config service; fence guards routes', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-bridge-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const svc = createConfigService({
    storageDir: dir,
    globalFile: join(dir, 'agents.json'),
    workspaceResolver: { resolve: () => ({ root: dir }) },
  })
  let registered = null
  const web = { register: (route) => { registered = route; return () => { registered = null } } }
  mountBridge(web, { config: svc, engine: () => undefined })
  assert.equal(registered.kind, 'prefix')

  // fence first: a rebinding Host never reaches the handler
  const refused = await handle(registered.handler, fakeReq('GET', '/dsh-mcp-manager/preview', { host: 'evil.test' }), fakeRes())
  assert.equal(refused.status, 403)

  // preview of an empty world
  const empty = await handle(registered.handler, fakeReq('GET', '/dsh-mcp-manager/preview'), fakeRes())
  assert.equal(empty.status, 200)
  assert.equal(empty.json.entries.length, 0)

  // save a global standard entry, then see it in preview
  const saved = await handle(registered.handler, fakeReq('POST', '/dsh-mcp-manager/entry', { body: { level: 'global', source: 'standard', name: 'alpha', def: { command: 'node x.js' }, expectedRevision: '' } }), fakeRes())
  assert.equal(saved.status, 200)
  const after = await handle(registered.handler, fakeReq('GET', '/dsh-mcp-manager/preview'), fakeRes())
  assert.equal(after.json.entries.length, 1)
  assert.equal(after.json.entries[0].name, 'alpha')

  // conflict surfaces as 409
  const clash = await handle(registered.handler, fakeReq('POST', '/dsh-mcp-manager/entry', { body: { level: 'global', source: 'standard', name: 'alpha', def: { command: 'node y.js' }, expectedRevision: 'stale' } }), fakeRes())
  assert.equal(clash.status, 409)

  // engine off is a structured answer, not an error
  const engine = await handle(registered.handler, fakeReq('GET', '/dsh-mcp-manager/engine'), fakeRes())
  assert.equal(engine.json.off, true)
})

test('bridge: the P5 management routes all answer (session, calls, tokens)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-bridge2-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const globalFile = join(dir, 'agents.json')
  const svc = createConfigService({
    storageDir: dir,
    globalFile,
    workspaceResolver: { resolve: () => ({ root: dir }) },
  })

  const seen = []
  const fakeEngine = {
    request: async (method, params) => {
      seen.push({ method, params })
      switch (method) {
        case 'mcp.calls': return { name: params.name, calls: [{ seq: 9, ts: 't', tool: 'x', preview: 'p' }], page: params.page, pageSize: 20, more: false }
        case 'mcp.callDetail': return { call: { seq: params.seq, tool: 'x', output: 'full' } }
        case 'mcp.callSources': return { sources: [{ name: params.name, session: false }, { name: 's0123456789-abcdef0123-' + params.name, session: true, lastSeq: 4 }] }
        case 'tokens.list': return { tokens: [{ id: 'default', label: 'default', createdAt: '' }] }
        case 'tokens.create': return { id: 't1', label: params.label, secret: 's1', createdAt: 'x' }
        case 'tokens.reveal': return { id: params.id, label: 'l', secret: 'sec' }
        case 'tokens.rotate': return { id: params.id, label: 'l', secret: 'sec2' }
        case 'tokens.revoke': return { ok: true }
        default: throw new Error('unexpected method ' + method)
      }
    },
  }

  let registered = null
  const web = { register: (route) => { registered = route; return () => { registered = null } } }
  mountBridge(web, { config: svc, engine: () => fakeEngine, storageDir: dir, globalFile })
  const H = (method, path, opts = {}) => handle(registered.handler, fakeReq(method, '/dsh-mcp-manager' + path, opts), fakeRes())

  // seed: a global standard entry
  await H('POST', '/entry', { body: { level: 'global', source: 'standard', name: 'alpha', def: { command: 'node x.js' }, expectedRevision: '' } })

  // --- session view: empty file answers revision + no snapshot ---
  const s1 = await H('GET', '/session?ss=sess1')
  assert.equal(s1.status, 200)
  assert.equal(s1.json.sessionId, 'sess1')
  assert.equal(s1.json.snapshot, undefined)

  // --- session view: a v2 snapshot maps to {revision, registeredAt, tools} ---
  const { writeSessionFile, sessionFilePath } = await import('../dist/config/session-store.js')
  const { publicNameLite } = await import('../dist/runtime/session-runtime.js')
  await writeSessionFile(sessionFilePath(dir, 'sess2'), {
    schemaVersion: 1, overrides: {},
    snapshot: { version: 2, workspaceId: 'w', registeredAt: 'R', configRevision: 'CR', servers: [{ logical: 'logical', instance: 'inst1', def: { type: 'echo' }, tools: [{ name: 'toolA' }] }] },
  })
  const s2 = await H('GET', '/session?ss=sess2')
  assert.equal(s2.status, 200)
  assert.deepEqual(s2.json.snapshot, { revision: 'CR', registeredAt: 'R', tools: [publicNameLite('logical', 'toolA')] })
  assert.equal(s2.json.revision.length, 16)
  const sBad = await H('GET', '/session')
  assert.equal(sBad.status, 400)

  // --- calls: page + detail ---
  const c1 = await H('GET', '/mcp/alpha/calls?page=2')
  assert.equal(c1.status, 200)
  assert.equal(c1.json.name, 'alpha')
  assert.deepEqual(seen.at(-1), { method: 'mcp.calls', params: { name: 'alpha', page: 2 } })
  const c2 = await H('GET', '/mcp/alpha/calls/9')
  assert.equal(c2.status, 200)
  assert.deepEqual(seen.at(-1), { method: 'mcp.callDetail', params: { name: 'alpha', seq: 9 } })
  // A HYPHENATED action. The dispatcher matched actions with `\w+`, so this
  // route answered "no route" — a client-visible 500 for a route that was
  // wired end to end everywhere else.
  const c3 = await H('GET', '/mcp/alpha/call-sources')
  assert.equal(c3.status, 200, 'hyphenated actions reach their handler')
  assert.equal(c3.json.sources.length, 2)
  assert.deepEqual(seen.at(-1), { method: 'mcp.callSources', params: { name: 'alpha' } })

  // --- tokens: list/create/reveal/rotate/revoke ---
  const k1 = await H('GET', '/tokens')
  assert.equal(k1.status, 200)
  assert.equal(k1.json.tokenEnv, 'MCP_GATEWAY_TOKEN')
  assert.equal(k1.json.tokens[0].id, 'default')
  const k2 = await H('POST', '/tokens', { body: { label: 'laptop' } })
  assert.deepEqual(seen.at(-1), { method: 'tokens.create', params: { label: 'laptop' } })
  const k3 = await H('GET', '/tokens/t1/secret')
  assert.deepEqual(seen.at(-1), { method: 'tokens.reveal', params: { id: 't1' } })
  const k4 = await H('POST', '/tokens/t1/rotate')
  assert.deepEqual(seen.at(-1), { method: 'tokens.rotate', params: { id: 't1' } })
  const k5 = await H('DELETE', '/tokens/t1')
  assert.equal(k5.status, 200)
  assert.deepEqual(seen.at(-1), { method: 'tokens.revoke', params: { id: 't1' } })
})

test('bridge: /import plans a pasted document as a dry run, then writes it entry by entry', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-import-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const svc = createConfigService({
    storageDir: dir,
    globalFile: join(dir, 'agents.json'),
    workspaceResolver: { resolve: () => ({ root: dir }) },
  })
  let registered = null
  mountBridge({ register: (route) => { registered = route; return () => {} } }, { config: svc, engine: () => undefined })
  const post = (body) => handle(registered.handler, fakeReq('POST', '/dsh-mcp-manager/import', { body }), fakeRes())
  const preview = () => handle(registered.handler, fakeReq('GET', '/dsh-mcp-manager/preview'), fakeRes())

  // an occupied name forces the importer to allocate around it
  await handle(registered.handler, fakeReq('POST', '/dsh-mcp-manager/entry', {
    body: { level: 'global', source: 'standard', name: 'ctx7', def: { command: 'node old.js' }, expectedRevision: '' },
  }), fakeRes())

  const doc = JSON.stringify({
    mcpServers: {
      ctx7: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
      remote: { url: 'https://example.test/mcp' },
      broken: { note: 'neither a command nor a url' },
    },
  })

  const planned = await post({ layerId: 'global:standard', text: doc })
  assert.equal(planned.status, 200)
  assert.deepEqual(planned.json.add.map((r) => r.name), ['ctx7-1', 'remote'], 'the taken name is reallocated')
  assert.equal(planned.json.skip.length, 1)
  assert.match(planned.json.skip[0].reason, /command or a url/)
  assert.equal((await preview()).json.entries.length, 1, 'planning wrote nothing')

  const applied = await post({ layerId: 'global:standard', text: doc, apply: true })
  assert.equal(applied.status, 200)
  assert.deepEqual(applied.json.added, ['ctx7-1', 'remote'])
  assert.deepEqual(applied.json.failed, [])
  const names = (await preview()).json.entries.map((e) => e.name).sort()
  assert.deepEqual(names, ['ctx7', 'ctx7-1', 'remote'], 'both entries landed beside the original')

  // bad input is a 4xx with an explanation, never a 500
  assert.equal((await post({ layerId: 'global:standard', text: 'not json' })).status, 400)
  assert.equal((await post({ layerId: 'nope:nope', text: '{}' })).status, 400)
})

test('bridge: /rename moves an entry on its own layer and refuses collisions', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-rename-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const svc = createConfigService({
    storageDir: dir,
    globalFile: join(dir, 'agents.json'),
    workspaceResolver: { resolve: () => ({ root: dir }) },
  })
  let registered = null
  mountBridge({ register: (route) => { registered = route; return () => {} } }, { config: svc, engine: () => undefined })
  const H = (method, path, body) => handle(registered.handler, fakeReq(method, '/dsh-mcp-manager' + path, body !== undefined ? { body } : {}), fakeRes())

  const first = await H('POST', '/entry', { level: 'global', source: 'standard', name: 'alpha', def: { command: 'node a.js' }, expectedRevision: '' })
  const second = await H('POST', '/entry', { level: 'global', source: 'standard', name: 'beta', def: { command: 'node b.js' }, expectedRevision: first.json.revision })
  assert.equal(second.status, 200, 'both seeds landed')
  const before = (await H('GET', '/preview')).json
  assert.equal(before.entries.length, 2)
  const alpha = before.entries.find((e) => e.name === 'alpha')

  const bad = await H('POST', '/rename', { layerId: 'global:standard', from: 'alpha', to: 'beta', def: alpha.def, expectedRevision: alpha.revision })
  assert.equal(bad.status, 400, 'renaming onto a taken name is refused')
  assert.match(bad.json.error, /already taken/)

  const invalid = await H('POST', '/rename', { layerId: 'global:standard', from: 'alpha', to: 'has space', def: alpha.def, expectedRevision: alpha.revision })
  assert.equal(invalid.status, 400, 'a name the engine could never host is refused up front')

  const ok = await H('POST', '/rename', { layerId: 'global:standard', from: 'alpha', to: 'gamma', def: alpha.def, expectedRevision: alpha.revision })
  assert.equal(ok.status, 200)
  const after = (await H('GET', '/preview')).json
  assert.deepEqual(after.entries.map((e) => e.name).sort(), ['beta', 'gamma'], 'the old name is gone, the new one carries the def')
  assert.deepEqual(after.entries.find((e) => e.name === 'gamma').def, { command: 'node a.js' })
})

test('bridge: the engine routes that existed but were never reachable now answer (test / resource / clear calls)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-newroutes-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const svc = createConfigService({ storageDir: dir, globalFile: join(dir, 'agents.json'), workspaceResolver: { resolve: () => ({ root: dir }) } })
  const seen = []
  const fakeEngine = {
    request: async (method, params) => {
      seen.push({ method, params })
      if (method === 'mcp.test') return { testable: true, ok: false, ms: 12, error: "Access denied for user 'x'" }
      if (method === 'mcp.resourceRead') return { ok: true, mimeType: 'text/plain', text: 'BODY of ' + params.uri }
      if (method === 'mcp.clearCalls') return { ok: true }
      throw new Error('unexpected method ' + method)
    },
  }
  let registered = null
  mountBridge({ register: (route) => { registered = route; return () => {} } }, { config: svc, engine: () => fakeEngine, storageDir: dir })
  const H = (method, path, body) => handle(registered.handler, fakeReq(method, '/dsh-mcp-manager' + path, body !== undefined ? { body } : {}), fakeRes())

  const tested = await H('POST', '/mcp/test', { def: { type: 'mysql', url: 'mysql://x' } })
  assert.equal(tested.status, 200)
  assert.equal(tested.json.ok, false, 'an unreachable target is a 200 with ok:false, not an error')
  assert.match(tested.json.error, /Access denied/)
  assert.deepEqual(seen[0], { method: 'mcp.test', params: { def: { type: 'mysql', url: 'mysql://x' } } })
  assert.equal((await H('POST', '/mcp/test', { def: null })).status, 400, 'a missing def is a 400')

  const read = await H('GET', '/mcp/alpha/resource?uri=file:///x.txt')
  assert.equal(read.status, 200)
  assert.equal(read.json.text, 'BODY of file:///x.txt')
  assert.equal((await H('GET', '/mcp/alpha/resource')).status, 400, 'a resource read needs a uri')

  const cleared = await H('DELETE', '/mcp/alpha/calls')
  assert.equal(cleared.status, 200)
  assert.equal(seen.at(-1).method, 'mcp.clearCalls')
})

test('view-order: grouping sorts before ungrouped, moves renumber only the entry’s own bucket', async () => {
  const { sortEntries, moveEntry, groupsOf } = await import('../dist/shared/view-order.js')
  const entries = ['alpha', 'beta', 'gamma', 'delta'].map((name) => ({ name }))
  const views = { alpha: { group: 'db' }, gamma: { group: 'db' }, beta: { group: 'ai' } }

  assert.deepEqual(sortEntries(entries, views).map((e) => e.name), ['beta', 'alpha', 'gamma', 'delta'],
    'groups by name first (ai, db), ungrouped last')
  assert.deepEqual(groupsOf(views), ['ai', 'db'])
  assert.deepEqual(sortEntries(entries, {}).map((e) => e.name), ['alpha', 'beta', 'delta', 'gamma'],
    'with no metadata the list is simply alphabetical')

  // moving gamma up swaps it with alpha INSIDE the db bucket; nothing else moves
  const moved = moveEntry(entries, views, 'gamma', -1)
  assert.deepEqual(sortEntries(entries, moved).map((e) => e.name), ['beta', 'gamma', 'alpha', 'delta'])
  assert.equal(moved.beta.order, undefined, 'a different bucket is untouched')
  // off the end is a no-op, not a throw or a wrap-around
  assert.deepEqual(sortEntries(entries, moveEntry(entries, moved, 'gamma', -1)).map((e) => e.name),
    ['beta', 'gamma', 'alpha', 'delta'])
})

test('bridge: /view persists grouping and order without touching any config layer', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-view-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const globalFile = join(dir, 'agents.json')
  const svc = createConfigService({ storageDir: dir, globalFile, workspaceResolver: { resolve: () => ({ root: dir }) } })
  let registered = null
  mountBridge({ register: (route) => { registered = route; return () => {} } }, { config: svc, engine: () => undefined, storageDir: dir })
  const H = (method, path, body) => handle(registered.handler, fakeReq(method, '/dsh-mcp-manager' + path, body !== undefined ? { body } : {}), fakeRes())

  let rev = ''
  for (const name of ['alpha', 'beta']) {
    rev = (await H('POST', '/entry', { level: 'global', source: 'standard', name, def: { command: 'node x.js' }, expectedRevision: rev })).json.revision
  }
  const fileBefore = readFileSync(globalFile, 'utf8')

  assert.deepEqual((await H('GET', '/view')).json.entries, {}, 'no metadata to begin with')
  const grouped = await H('POST', '/view', { name: 'alpha', group: 'databases' })
  assert.equal(grouped.status, 200)
  assert.equal(grouped.json.entries.alpha.group, 'databases')
  assert.deepEqual(grouped.json.groups, ['databases'])
  assert.equal((await H('GET', '/view')).json.entries.alpha.group, 'databases', 'it survives a reread')

  assert.equal(readFileSync(globalFile, 'utf8'), fileBefore,
    'the shared .mcp.json is byte-identical — grouping is panel state, not config')

  // clearing takes it out of every group
  assert.equal((await H('POST', '/view', { name: 'alpha', group: null })).json.entries.alpha, undefined)
  // an unknown entry is refused rather than accumulating dead metadata
  assert.equal((await H('POST', '/view', { name: 'ghost', group: 'x' })).status, 400)

  // metadata follows a rename
  await H('POST', '/view', { name: 'beta', group: 'ai' })
  const beta = (await H('GET', '/preview')).json.entries.find((e) => e.name === 'beta')
  const renamed = await H('POST', '/rename', { layerId: 'global:standard', from: 'beta', to: 'bravo', def: beta.def, expectedRevision: beta.revision })
  assert.equal(renamed.status, 200)
  const after = (await H('GET', '/view')).json
  assert.equal(after.entries.bravo?.group, 'ai', 'the new name keeps the grouping')
  assert.equal(after.entries.beta, undefined, 'the old name is gone')
})

test('listener: resolving the MCP endpoint — config first, then the panel, then off', () => {
  // Off is the default, and an unpublished endpoint keeps port 0: the host
  // reaches the engine over its private pipe, so the number is nobody's business.
  assert.deepEqual(resolveListener(undefined, undefined), { enabled: false, port: 0, locked: false })

  // "On" has to mean a port a client can be told about, so an unnamed one is
  // the default rather than an ephemeral one that moves every restart.
  assert.deepEqual(resolveListener(undefined, { enabled: true }), { enabled: true, port: DEFAULT_MCP_PORT, locked: false })
  assert.deepEqual(resolveListener(undefined, { enabled: true, port: 8123 }), { enabled: true, port: 8123, locked: false })

  // A config file outranks the panel, and says so, so the switch can be shown
  // as someone else's decision instead of silently doing nothing.
  assert.deepEqual(resolveListener({ publicMcp: true }, { enabled: false, port: 8123 }),
    { enabled: true, port: 8123, locked: true })
  assert.deepEqual(resolveListener({ httpPort: 3000 }, { enabled: true, port: 8123 }),
    { enabled: true, port: 3000, locked: true })
  assert.deepEqual(resolveListener({ publicMcp: false }, { enabled: true, port: 8123 }),
    { enabled: false, port: 8123, locked: true }, 'the config can turn it off over the panel too')

  // Junk in the stored file must not decide a port.
  assert.equal(resolveListener(undefined, { enabled: true, port: 70000 }).port, DEFAULT_MCP_PORT)
  assert.equal(resolveListener(undefined, { enabled: true, port: 'abc' }).port, DEFAULT_MCP_PORT)
})

test('bridge: the MCP endpoint answers with the engine down, and refuses to fight the config', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-listener-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const svc = createConfigService({ storageDir: dir, globalFile: join(dir, 'agents.json'), workspaceResolver: { resolve: () => ({ root: dir }) } })
  let fixed
  let registered = null
  mountBridge({ register: (route) => { registered = route; return () => {} } },
    { config: svc, engine: () => undefined, storageDir: dir, listenerConfig: () => fixed })
  const H = (method, path, body) => handle(registered.handler, fakeReq(method, '/dsh-mcp-manager' + path, body !== undefined ? { body } : {}), fakeRes())

  // "It is off" is exactly when someone comes here to turn it on, so this must
  // not be behind the engine-is-enabled guard.
  const initial = await H('GET', '/listener')
  assert.equal(initial.status, 200)
  assert.deepEqual(initial.json, { enabled: false, port: 0, locked: false })

  const saved = await H('POST', '/listener', { enabled: true, port: 0 })
  assert.equal(saved.status, 200)
  assert.equal(saved.json.enabled, true)
  assert.equal(saved.json.port, DEFAULT_MCP_PORT, 'publishing without a port names the default')
  assert.equal(saved.json.restartRequired, true, 'the supervisor binds at the next load, and says so')

  const back = await H('GET', '/listener')
  assert.deepEqual(back.json.stored, { enabled: true, port: DEFAULT_MCP_PORT }, 'it survives the round trip')
  assert.equal(back.json.port, DEFAULT_MCP_PORT)

  assert.equal((await H('POST', '/listener', { enabled: true, port: 70000 })).status, 500, 'a port that is not one is refused')

  // Once the config decides, the panel is a display of that decision.
  fixed = { publicMcp: false }
  const locked = await H('GET', '/listener')
  assert.equal(locked.json.locked, true)
  assert.equal(locked.json.enabled, false, 'the config wins over what the panel had stored')
  const refused = await H('POST', '/listener', { enabled: true, port: 8123 })
  assert.equal(refused.status, 500)
  assert.match(refused.json.error, /fixed by the plugin config/)
  assert.deepEqual((await H('GET', '/listener')).json.stored, { enabled: true, port: DEFAULT_MCP_PORT },
    'and the refusal wrote nothing')
})

test('listener: a port someone else holds turns the endpoint off, it does not take the host down', async (t) => {
  // The failure this prevents: the engine could not bind, so it died, so the
  // plugin would not load — and the settings panel went with it, which is the
  // only place the port could have been changed. Unpublished-with-a-reason is
  // recoverable; a dead plugin is not.
  const squatter = createServer()
  await new Promise((resolve) => squatter.listen(0, '127.0.0.1', resolve))
  const taken = squatter.address().port
  t.after(() => new Promise((resolve) => squatter.close(resolve)))

  assert.equal(await portFree(taken), false, 'the probe binds for real, so it agrees with the engine')
  const applied = await applyListener({ enabled: true, port: taken, locked: false })
  assert.equal(applied.enabled, false, 'not published')
  assert.equal(applied.port, 0)
  assert.match(applied.problem, /already in use/)
  assert.match(applied.problem, new RegExp(String(taken)), 'and names the port, so it can be changed')

  // A free port is left exactly as it was asked for.
  await new Promise((resolve) => squatter.close(resolve))
  const free = await applyListener({ enabled: true, port: taken, locked: false })
  assert.deepEqual(free, { enabled: true, port: taken, locked: false })

  // Off, and ephemeral, are never probed — there is nothing to clash with.
  assert.deepEqual(await applyListener({ enabled: false, port: 0, locked: false }), { enabled: false, port: 0, locked: false })
  assert.equal(await portFree(0), true)
})

test("bridge: /view keeps another workspace's grouping — ui-view.json is one file, not one per scope", async (t) => {
  const dirA = mkdtempSync(join(tmpdir(), 'mcp-viewA-'))
  const dirB = mkdtempSync(join(tmpdir(), 'mcp-viewB-'))
  t.after(() => { rmSync(dirA, { recursive: true, force: true }); rmSync(dirB, { recursive: true, force: true }) })
  // One project entry per workspace, so each scope's preview sees a name the other never does.
  writeFileSync(join(dirA, '.mcp.json'), JSON.stringify({ mcpServers: { 'only-a': { command: 'node a.js' } } }))
  writeFileSync(join(dirB, '.mcp.json'), JSON.stringify({ mcpServers: { 'only-b': { command: 'node b.js' } } }))
  const svc = createConfigService({
    storageDir: dirA,
    globalFile: join(dirA, 'agents.json'),
    workspaceResolver: { resolve: (id) => ({ root: id === 'B' ? dirB : dirA }) },
  })
  let registered = null
  mountBridge({ register: (route) => { registered = route; return () => {} } }, { config: svc, engine: () => undefined, storageDir: dirA })
  const H = (method, path, body) => handle(registered.handler, fakeReq(method, '/dsh-mcp-manager' + path, body !== undefined ? { body } : {}), fakeRes())

  assert.equal((await H('POST', '/view?ws=A', { name: 'only-a', group: 'left' })).status, 200)
  assert.equal((await H('POST', '/view?ws=B', { name: 'only-b', group: 'right' })).status, 200)

  // The write made while B was selected must not erase A. ui-view.json is plugin-wide, while the
  // set of entries a request can see is only ever one scope's, so pruning to it was data loss.
  const all = (await H('GET', '/view')).json
  assert.equal(all.entries['only-a']?.group, 'left', "workspace A's grouping survived a write made in B")
  assert.equal(all.entries['only-b']?.group, 'right')
})
