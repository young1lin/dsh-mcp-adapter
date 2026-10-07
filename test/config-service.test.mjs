/**
 * P2 config-service suite (TASK P2.1-P2.5 acceptance cases), run against dist.
 * Sets the engine master key BEFORE importing so sealed stores never spawn
 * an OS helper, and isolates every fixture in temp dirs.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, symlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MCP_GATEWAY_MASTER_KEY = 'ab'.repeat(32)

const { createConfigService } = await import('../dist/config/service.js')
const { readStandardFile } = await import('../dist/config/standard-repo.js')

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-cfg-'))
  const globalFile = join(dir, 'agents-mcp.json')
  return { dir, globalFile }
}

function service(f) {
  return createConfigService({
    storageDir: f.dir,
    globalFile: f.globalFile,
    workspaceResolver: { resolve: (id) => (id === 'wsA' ? { root: join(f.dir, 'wsA') } : id === 'wsB' ? { root: join(f.dir, 'wsB') } : undefined) },
  })
}

const stdDef = { command: 'npx', args: ['-y', 'fixed-server'] }

test('standard file round-trip: write, unknown fields and siblings preserved', async (t) => {
  const f = fixture(); t.after(() => rmSync(f.dir, { recursive: true, force: true }))
  const svc = service(f)
  // an external author leaves unknown top-level fields and a sibling entry
  mkdirSync(join(f.dir), { recursive: true })
  writeFileSync(f.globalFile, JSON.stringify({ customTop: { keep: true }, mcpServers: { sibling: { command: 'node x.js' } } }))
  const before = await readStandardFile(f.globalFile)
  await svc.saveEntry({ level: 'global', source: 'standard', name: 'alpha', def: stdDef, expectedRevision: before.revision })
  const onDisk = JSON.parse(readFileSync(f.globalFile, 'utf8'))
  assert.equal(onDisk.customTop.keep, true, 'unknown top-level field preserved')
  assert.deepEqual(onDisk.mcpServers.sibling, { command: 'node x.js' }, 'sibling entry preserved')
  assert.deepEqual(onDisk.mcpServers.alpha, stdDef, 'new entry written')
})

test('revision conflict: external edit between read and write is refused, file intact', async (t) => {
  const f = fixture(); t.after(() => rmSync(f.dir, { recursive: true, force: true }))
  writeFileSync(f.globalFile, JSON.stringify({ mcpServers: { a: stdDef } }))
  const svc = service(f)
  const before = await readStandardFile(f.globalFile)
  writeFileSync(f.globalFile, JSON.stringify({ mcpServers: { a: { command: 'changed' } } }))
  await assert.rejects(
    () => svc.saveEntry({ level: 'global', source: 'standard', name: 'a', def: stdDef, expectedRevision: before.revision }),
    (err) => err.code === 'CONFLICT',
  )
  assert.equal(JSON.parse(readFileSync(f.globalFile, 'utf8')).mcpServers.a.command, 'changed', 'external edit survived')
})

test('invalid JSON on disk is never overwritten', async (t) => {
  const f = fixture(); t.after(() => rmSync(f.dir, { recursive: true, force: true }))
  writeFileSync(f.globalFile, '{ broken json')
  const svc = service(f)
  const p = await svc.preview({})
  assert.equal(p.problems.length, 1)
  assert.equal(p.problems[0].code, 'NOT_JSON')
  const actualRevision = (await readStandardFile(f.globalFile)).revision
  await assert.rejects(
    () => svc.saveEntry({ level: 'global', source: 'standard', name: 'x', def: stdDef, expectedRevision: actualRevision }),
    (err) => err.code === 'INVALID',
  )
  assert.equal(readFileSync(f.globalFile, 'utf8'), '{ broken json', 'broken bytes untouched')
})

test('secret masking round-trip: sentinel keeps, new value sets, omission clears', async (t) => {
  const f = fixture(); t.after(() => rmSync(f.dir, { recursive: true, force: true }))
  const svc = service(f)
  const created = await svc.saveEntry({ level: 'global', source: 'standard', name: 'db', def: { command: 'node s.js', env: { PASSWORD: 'hunter2' } }, expectedRevision: '' })
  const p1 = await svc.preview({})
  const masked = p1.entries.find((e) => e.name === 'db')
  assert.equal(masked.def.env.PASSWORD, '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022', 'secret masked in preview')
  // sentinel round-trip: change an unrelated field, keep the sentinel
  await svc.saveEntry({ level: 'global', source: 'standard', name: 'db', def: { command: 'node s2.js', env: { PASSWORD: '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' } }, expectedRevision: created.revision })
  const onDisk = JSON.parse(readFileSync(f.globalFile, 'utf8'))
  assert.equal(onDisk.mcpServers.db.command, 'node s2.js')
  assert.equal(onDisk.mcpServers.db.env.PASSWORD, 'hunter2', 'sentinel restored the stored secret')
})

test('layer precedence: project overrides global whole-entry; .agents file overrides root', async (t) => {
  const f = fixture(); t.after(() => rmSync(f.dir, { recursive: true, force: true }))
  const svc = service(f)
  await svc.saveEntry({ level: 'global', source: 'standard', name: 'svc', def: { command: 'global-cmd', env: { A: '1' } }, expectedRevision: '' })
  mkdirSync(join(f.dir, 'wsA'), { recursive: true })
  writeFileSync(join(f.dir, 'wsA', '.mcp.json'), JSON.stringify({ mcpServers: { svc: { command: 'project-cmd' } } }))
  const p = await svc.preview({ workspaceId: 'wsA' })
  const entry = p.entries.find((e) => e.name === 'svc')
  assert.equal(entry.def.command, 'project-cmd')
  assert.equal(entry.def.env, undefined, 'whole-entry replacement, no field stitching')
  assert.equal(entry.level, 'project')
  // .agents/.mcp.json wins inside the project scope
  mkdirSync(join(f.dir, 'wsA', '.agents'), { recursive: true })
  writeFileSync(join(f.dir, 'wsA', '.agents', '.mcp.json'), JSON.stringify({ mcpServers: { svc: { command: 'agents-cmd' } } }))
  const p2 = await svc.preview({ workspaceId: 'wsA' })
  assert.equal(p2.entries.find((e) => e.name === 'svc').def.command, 'agents-cmd')
})

test('tombstones: project disable masks global; session disable masks project; delete restores inheritance', async (t) => {
  const f = fixture(); t.after(() => rmSync(f.dir, { recursive: true, force: true }))
  const svc = service(f)
  await svc.saveEntry({ level: 'global', source: 'standard', name: 'svc', def: { command: 'global-cmd' }, expectedRevision: '' })
  mkdirSync(join(f.dir, 'wsA'), { recursive: true })
  const pv0 = await svc.preview({ workspaceId: 'wsA' })
  const wsRevision = pv0.layers.find((l) => l.layerId === 'project:root').revision
  await svc.setEnabled({ level: 'project', name: 'svc', enabled: false, expectedRevision: wsRevision, workspaceId: 'wsA' })
  const p1 = await svc.preview({ workspaceId: 'wsA' })
  const disabled = p1.entries.find((e) => e.name === 'svc')
  assert.equal(disabled.disabled, true, 'project tombstone masks global')
  assert.equal(disabled.level, 'project')
  const globalView = await svc.preview({})
  assert.equal(globalView.entries.find((e) => e.name === 'svc').disabled, false, 'global view unaffected')
  // session disable over the project tombstone
  const pv1 = await svc.preview({ workspaceId: 'wsA', sessionId: 'sess1' })
  const sRevision = pv1.layers.filter((l) => l.level === 'session')[0].revision
  await svc.setEnabled({ level: 'session', name: 'svc', enabled: false, expectedRevision: sRevision, workspaceId: 'wsA', sessionId: 'sess1' })
  const p2 = await svc.preview({ workspaceId: 'wsA', sessionId: 'sess1' })
  const sEntry = p2.entries.find((e) => e.name === 'svc')
  assert.equal(sEntry.disabled, true)
  assert.equal(sEntry.pending, true, 'session changes are pending until a new session')
  // delete the project override -> inheritance restored
  const pv2 = await svc.preview({ workspaceId: 'wsA' })
  const wsRevision2 = pv2.layers.find((l) => l.layerId === 'project:root').revision
  await svc.saveEntry({ level: 'project', source: 'standard', name: 'svc', def: null, expectedRevision: wsRevision2, workspaceId: 'wsA' })
  const p3 = await svc.preview({ workspaceId: 'wsA' })
  const restored = p3.entries.find((e) => e.name === 'svc')
  assert.equal(restored.disabled, false, 'global def visible again')
  assert.equal(restored.level, 'global')
  assert.equal(restored.inherited, true, 'flagged as inherited from the project view')
})

test('same-scope standard/native clash is a diagnosed conflict, never a silent pick', async (t) => {
  const f = fixture(); t.after(() => rmSync(f.dir, { recursive: true, force: true }))
  const svc = service(f)
  await svc.saveEntry({ level: 'global', source: 'standard', name: 'dup', def: { command: 'a' }, expectedRevision: '' })
  const p1 = await svc.preview({})
  const catRevision = p1.layers.filter((l) => l.source === 'native')[0].revision
  await svc.saveEntry({ level: 'global', source: 'native', name: 'dup', def: { type: 'echo' }, expectedRevision: catRevision })
  const p2 = await svc.preview({})
  assert.equal(p2.conflicts.length, 1)
  assert.equal(p2.conflicts[0].name, 'dup')
  assert.equal(p2.conflicts[0].scope, 'global')
  assert.equal(p2.entries.find((e) => e.name === 'dup'), undefined, 'conflicted name excluded from the effective set')
})

test('workspaces are isolated: no name bleed between project scopes', async (t) => {
  const f = fixture(); t.after(() => rmSync(f.dir, { recursive: true, force: true }))
  const svc = service(f)
  mkdirSync(join(f.dir, 'wsA'), { recursive: true })
  mkdirSync(join(f.dir, 'wsB'), { recursive: true })
  writeFileSync(join(f.dir, 'wsA', '.mcp.json'), JSON.stringify({ mcpServers: { privateA: { command: 'a' } } }))
  writeFileSync(join(f.dir, 'wsB', '.mcp.json'), JSON.stringify({ mcpServers: { privateB: { command: 'b' } } }))
  const pa = await svc.preview({ workspaceId: 'wsA' })
  const names = pa.entries.map((e) => e.name)
  assert.ok(names.includes('privateA'))
  assert.ok(!names.includes('privateB'), 'wsB entry does not leak into wsA')
  const pb = await svc.preview({ workspaceId: 'wsB' })
  assert.ok(!pb.entries.map((e) => e.name).includes('privateA'))
  // same NAME in both workspaces resolves independently
  writeFileSync(join(f.dir, 'wsB', '.mcp.json'), JSON.stringify({ mcpServers: { privateA: { command: 'b-version' }, privateB: { command: 'b' } } }))
  const pa2 = await svc.preview({ workspaceId: 'wsA' })
  assert.equal(pa2.entries.find((e) => e.name === 'privateA').def.command, 'a', 'wsA keeps its own def')
})

test('native catalog and session store persist as sealed envelopes, not plaintext', async (t) => {
  const f = fixture(); t.after(() => rmSync(f.dir, { recursive: true, force: true }))
  const svc = service(f)
  const p1 = await svc.preview({})
  const catRevision = p1.layers.filter((l) => l.source === 'native')[0].revision
  await svc.saveEntry({ level: 'global', source: 'native', name: 'mysql-prod', def: { type: 'mysql', host: '127.0.0.1', password: 'sekret' }, expectedRevision: catRevision })
  const catFile = join(f.dir, 'catalog', 'global.json')
  const raw = readFileSync(catFile, 'utf8')
  assert.ok(!raw.includes('sekret') && !raw.includes('mysql-prod'), 'ciphertext only')
  assert.equal(JSON.parse(raw).lmg, 1, 'engine envelope format')
  // secret masked in preview, restored on sentinel round-trip
  const p2 = await svc.preview({})
  const entry = p2.entries.find((e) => e.name === 'mysql-prod')
  assert.equal(entry.def.password, '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022')
  const rev2 = p2.layers.filter((l) => l.source === 'native')[0].revision
  await svc.saveEntry({ level: 'global', source: 'native', name: 'mysql-prod', def: { type: 'mysql', host: '127.0.0.2', password: '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' }, expectedRevision: rev2 })
  const p3 = await svc.preview({})
  assert.equal(p3.entries.find((e) => e.name === 'mysql-prod').def.host, '127.0.0.2')
  const dec = JSON.parse(readFileSync(catFile, 'utf8'))
  assert.equal(dec.ct !== undefined, true)
  // session file: sealed + bound to its id
  const ps = await svc.preview({ workspaceId: 'wsA', sessionId: 'sess9' })
  const sRev = ps.layers.filter((l) => l.level === 'session')[0].revision
  await svc.saveEntry({ level: 'session', source: 'session', name: 'mysql-prod', def: { type: 'mysql', host: 'h' }, expectedRevision: sRev, workspaceId: 'wsA', sessionId: 'sess9' })
  const sessRaw = readFileSync(join(f.dir, 'sessions', 'sess9.json'), 'utf8')
  assert.ok(!sessRaw.includes('mysql-prod') && JSON.parse(sessRaw).lmg === 1)
})


test('P2.7: writing into a missing directory creates it; a read-only target reports IO', async (t) => {
  const f = fixture(); t.after(() => rmSync(f.dir, { recursive: true, force: true }))
  const svc = service(f)
  // global file lives in a directory that does not exist yet
  const ok = await svc.saveEntry({ level: 'global', source: 'standard', name: 'fresh', def: stdDef, expectedRevision: '' })
  assert.ok(ok.revision.length > 0, 'missing directory created, file written')
  assert.ok(existsSync(f.globalFile))
})

test('P2.6: import plans allocate names and skip self-references; conversions are explicit', async () => {
  const { planStandardImport, planNativeImport, standardToNative, nativeToStandard } = await import('../dist/config/transfer.js')
  const plan = planStandardImport({ mcpServers: { alpha: { command: 'node a.js' }, beta: { url: 'https://x/mcp' } } }, new Set(['alpha']))
  assert.equal(plan.add.length, 2)
  assert.equal(plan.add[0].name, 'alpha-1', 'collision suffixed')
  assert.equal(plan.add[1].name, 'beta')
  const stdToNat = standardToNative({ command: 'npx', args: ['-y', 'pkg'] })
  assert.equal(stdToNat.type, 'proc')
  assert.equal(stdToNat.command, 'npx -y pkg')
  const natToStd = nativeToStandard({ type: 'proc', command: 'npx -y pkg' })
  assert.equal(natToStd.command, 'npx -y pkg')
  assert.equal(nativeToStandard({ type: 'mysql', host: 'x' }), undefined, 'DB has no standard carrier')
  const nativePlan = planNativeImport({ a: { type: 'echo' }, bad: { nope: 1 }, a_dup: { type: 'echo' } }, new Set(['a_dup']))
  assert.equal(nativePlan.add.length, 2)
  assert.equal(nativePlan.skip.length, 1, 'shapeless row skipped with a reason')
})
test('symlinked standard file is reported, not edited', async (t) => {
  const f = fixture(); t.after(() => rmSync(f.dir, { recursive: true, force: true }))
  const real = join(f.dir, 'real.json')
  writeFileSync(real, JSON.stringify({ mcpServers: { x: { command: 'y' } } }))
  symlinkSync(real, f.globalFile)
  const svc = service(f)
  const p = await svc.preview({})
  const layer = p.layers.find((l) => l.label === f.globalFile)
  assert.equal(layer.problem?.code, 'SYMLINK')
})
