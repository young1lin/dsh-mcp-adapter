/** Claude/agents path discovery and safe source-preserving merge regressions. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

process.env.MCP_GATEWAY_MASTER_KEY = 'ab'.repeat(32)
const { createConfigService } = await import('../dist/config/service.js')
const { globalStandardLayers, projectStandardLayers } = await import('../dist/config/standard-paths.js')
const { validateConfig } = await import('../dist/config.js')
const { standardToNative } = await import('../dist/config/transfer.js')
const { tokenizeCommand } = await import('../dist/engine/adapters/proc.js')

function fixture(t, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-claude-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const homeDir = join(dir, 'home')
  const root = join(dir, 'workspace')
  const svc = createConfigService({ storageDir: join(dir, 'store'), homeDir, workspaceResolver: { resolve: (id) => id === 'ws' ? { root } : undefined }, ...extra })
  const files = [...globalStandardLayers(undefined, homeDir), ...projectStandardLayers(root)]
  const pathFor = (layerId) => files.find((l) => l.layerId === layerId).path
  const put = (layerId, servers, fields = {}) => {
    const path = pathFor(layerId)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ ...fields, mcpServers: servers }))
  }
  return { dir, homeDir, root, svc, files, pathFor, put }
}

const def = (command) => ({ command })

test('standard command+args preserves spaced executable paths, quotes, UNC and trailing separators', (t) => {
  const bs = String.fromCharCode(92)
  const command = ['C:', 'Program Files', 'nodejs', 'node.exe'].join(bs)
  const args = [['C:', 'my project', 'server.mjs'].join(bs), bs.repeat(2) + ['server', 'my share', ''].join(bs), 'a"b', 'plain']
  assert.equal(args[1].startsWith(bs.repeat(2)), true, 'fixture really is a UNC path')
  assert.equal(args[1].endsWith(bs), true, 'fixture really has a trailing separator')
  assert.deepEqual(tokenizeCommand(standardToNative({ command, args }).command), [command, ...args])
  assert.deepEqual(tokenizeCommand(standardToNative({ command: process.execPath }).command), [process.execPath])
  for (const command of ['/usr/bin/node server.mjs', ['C:', 'node', 'node.exe'].join(bs) + ' server.mjs']) assert.deepEqual(tokenizeCommand(standardToNative({ command }).command), tokenizeCommand(command))
  assert.equal(standardToNative({ command: 'node server.mjs' }).command, 'node server.mjs', 'legacy inline command without args retains its meaning')
  const f = fixture(t)
  const executable = join(f.dir, 'program files', 'executable')
  mkdirSync(dirname(executable), { recursive: true })
  writeFileSync(executable, '')
  assert.deepEqual(tokenizeCommand(standardToNative({ command: executable }).command), [executable], 'spaced executable without args is still one token')
})

test('discovery: process/session defaults share Claude < root < agents; custom globalFile pins once', async (t) => {
  const f = fixture(t)
  const paths = projectStandardLayers(f.root).map((l) => l.path)
  for (const project of ['process', 'session']) assert.deepEqual(validateConfig({ project, projectRoot: f.root }).projectFiles, paths)
  assert.deepEqual(globalStandardLayers(join(f.homeDir, '.agents', '.mcp.json'), f.homeDir), globalStandardLayers(undefined, f.homeDir))
  if (process.platform === 'win32') assert.equal(globalStandardLayers(join(f.homeDir, '.AGENTS', '.mcp.json'), f.homeDir).length, 2)
  const custom = f.pathFor('global:claude')
  assert.deepEqual(globalStandardLayers(custom, f.homeDir), [{ layerId: 'global:standard', path: custom }])
  f.put('global:claude', { pinned: def('custom') })
  f.put('global:standard', { unrelated: def('agents') })
  const svc = createConfigService({ storageDir: join(f.dir, 'pinned'), homeDir: f.homeDir, globalFile: custom })
  const p = await svc.preview({})
  assert.deepEqual(p.entries.map((e) => e.name), ['pinned'])
  assert.equal(p.layers.filter((l) => l.source === 'standard').length, 1, 'same physical file is not read twice')
})

test('all five standard files merge by name, whole-entry, existing source priority, no startup writes', async (t) => {
  const f = fixture(t)
  for (const [i, layer] of f.files.entries()) f.put(layer.layerId, { shared: { command: 'cmd-' + i, ...(i === 0 ? { env: { SECRET: 'lower-only' } } : {}) }, ['unique-' + i]: def('cmd-' + i) })
  const before = f.files.map((l) => readFileSync(l.path, 'utf8'))
  const p = await f.svc.preview({ workspaceId: 'ws', maskSecrets: false })
  assert.equal(p.entries.length, 6, 'five unique names plus exactly one shared name')
  const shared = p.entries.find((e) => e.name === 'shared')
  assert.equal(shared.layerId, 'project:agents')
  assert.deepEqual(shared.def, def('cmd-4'), 'no field stitching from any lower source')
  assert.equal(shared.overrides.length, 4)
  assert.deepEqual(p.conflicts, [])
  assert.deepEqual(p.problems, [])
  assert.deepEqual(f.files.map((l) => readFileSync(l.path, 'utf8')), before, 'reading/merging never migrates or rewrites files')
  const global = await f.svc.preview({})
  assert.equal(global.entries.find((e) => e.name === 'shared').layerId, 'global:standard')
  rmSync(f.pathFor('project:agents'))
  assert.equal((await f.svc.preview({ workspaceId: 'ws' })).entries.find((e) => e.name === 'shared').layerId, 'project:root')
  rmSync(f.pathFor('project:root'))
  assert.equal((await f.svc.preview({ workspaceId: 'ws' })).entries.find((e) => e.name === 'shared').layerId, 'project:claude')
})

test('Claude tombstones mask lower scopes; agents tombstones cannot resurrect via Claude', async (t) => {
  const f = fixture(t)
  f.put('global:claude', { svc: def('claude'), inherited: def('global') })
  f.put('global:standard', { svc: { disabled: true } })
  f.put('project:claude', { inherited: { disabled: true } })
  let p = await f.svc.preview({ workspaceId: 'ws', sessionId: 'sess' })
  assert.equal(p.entries.find((e) => e.name === 'svc').disabled, true)
  assert.equal(p.entries.find((e) => e.name === 'inherited').layerId, 'project:claude')
  assert.equal(p.entries.find((e) => e.name === 'inherited').disabled, true)
  f.put('project:agents', { svc: def('project') })
  await f.svc.setEnabled({ level: 'session', name: 'svc', enabled: false, expectedRevision: p.layers.find((l) => l.layerId === 'session:overrides').revision, workspaceId: 'ws', sessionId: 'sess' })
  p = await f.svc.preview({ workspaceId: 'ws', sessionId: 'sess' })
  assert.equal(p.entries.find((e) => e.name === 'svc').layerId, 'session:overrides')
  assert.equal(p.entries.find((e) => e.name === 'svc').disabled, true)
})

for (const layerId of ['global:claude', 'project:claude']) {
  test(layerId + ': edits/toggles/delete keep source, secrets, siblings, unknown fields and revisions', async (t) => {
    const f = fixture(t)
    const scope = layerId.startsWith('project:') ? { workspaceId: 'ws' } : {}
    const level = layerId.split(':')[0]
    const path = f.pathFor(layerId)
    f.put(layerId, { svc: { command: 'old', env: { PASSWORD: 'real-secret' } }, sibling: def('sibling') }, { custom: { keep: true } })
    const p = await f.svc.preview(scope)
    const entry = p.entries.find((e) => e.name === 'svc')
    assert.equal(entry.layerId, layerId)
    assert.equal(entry.def.env.PASSWORD, '••••••••')
    await f.svc.saveEntry({ level, source: 'standard', layerId, name: 'svc', def: { ...entry.def, command: 'new' }, expectedRevision: entry.revision, ...scope })
    let disk = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(disk.mcpServers.svc.env.PASSWORD, 'real-secret')
    assert.deepEqual(disk.custom, { keep: true })
    assert.deepEqual(disk.mcpServers.sibling, def('sibling'))
    await assert.rejects(() => f.svc.saveEntry({ level, source: 'standard', layerId, name: 'svc', def: entry.def, expectedRevision: entry.revision, ...scope }), (e) => e.code === 'CONFLICT')
    const current = (await f.svc.preview(scope)).entries.find((e) => e.name === 'svc')
    // Legacy callers omitting layerId still toggle the effective entry's OWN file.
    const toggled = await f.svc.setEnabled({ level, name: 'svc', enabled: false, expectedRevision: current.revision, ...scope })
    disk = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(disk.mcpServers.svc.disabled, true)
    await f.svc.saveEntry({ level, source: 'standard', layerId, name: 'svc', def: null, expectedRevision: toggled.revision, ...scope })
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).mcpServers.svc, undefined)
    assert.equal(existsSync(f.pathFor('global:standard')), false, 'no accidental global agents file')
    assert.equal(existsSync(f.pathFor('project:root')), false, 'no accidental project root file')
  })
}

test('bad Claude JSON and null entries are diagnosed without disabling healthy peers or rewriting bytes', async (t) => {
  const f = fixture(t)
  f.put('global:claude', { nullEntry: null, arrayEntry: [], primitive: 5, healthyGlobal: def('healthy') })
  f.put('project:claude', {})
  const path = f.pathFor('project:claude')
  writeFileSync(path, '{ broken')
  f.put('project:root', { healthyProject: def('project') })
  const p = await f.svc.preview({ workspaceId: 'ws' })
  assert.deepEqual(p.entries.map((e) => e.name).sort(), ['healthyGlobal', 'healthyProject'])
  assert.equal(p.problems.length, 4)
  assert.ok(p.problems.some((e) => e.code === 'NOT_JSON'))
  await assert.rejects(() => f.svc.saveEntry({ level: 'project', source: 'standard', layerId: 'project:claude', name: 'x', def: def('x'), expectedRevision: (p.layers.find((l) => l.layerId === 'project:claude')).revision, workspaceId: 'ws' }), (e) => e.code === 'INVALID')
  assert.equal(readFileSync(path, 'utf8'), '{ broken')
})

test('malformed disabled tombstones never resurrect lower enabled MCPs', async (t) => {
  const f = fixture(t)
  f.put('global:claude', { svc: def('lower') })
  f.put('global:standard', { svc: { disabled: true, command: null } })
  let p = await f.svc.preview({})
  assert.equal(p.entries[0].disabled, true)
  assert.equal(p.entries[0].layerId, 'global:standard')
  assert.equal(p.problems[0].code, 'BAD_SERVERS')
  f.put('project:claude', { svc: { disabled: true, env: 42 } })
  p = await f.svc.preview({ workspaceId: 'ws' })
  assert.equal(p.entries[0].disabled, true)
  assert.equal(p.entries[0].layerId, 'project:claude')
})

test('Claude standard/native clash remains a conflict and wrong-scope/path layer IDs are refused', async (t) => {
  const f = fixture(t)
  f.put('project:claude', { dup: def('claude') })
  let p = await f.svc.preview({ workspaceId: 'ws' })
  await f.svc.saveEntry({ level: 'project', source: 'native', name: 'dup', def: { type: 'echo' }, expectedRevision: p.layers.find((l) => l.layerId === 'project:native').revision, workspaceId: 'ws' })
  p = await f.svc.preview({ workspaceId: 'ws' })
  assert.deepEqual(p.entries, [])
  assert.equal(p.conflicts[0].name, 'dup')
  for (const layerId of ['global:claude', '../outside/.mcp.json', 'project:unknown']) {
    await assert.rejects(() => f.svc.saveEntry({ level: 'project', source: 'standard', layerId, name: 'x', def: def('x'), expectedRevision: '', workspaceId: 'ws' }), (e) => e.code === 'SCOPE')
  }
  await assert.rejects(() => f.svc.preview({ workspaceId: f.root }), (e) => e.code === 'SCOPE', 'workspace ID is never interpreted as a path')
})
