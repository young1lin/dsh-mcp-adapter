/**
 * P6 migration tests: read-only pre-check (plaintext sources are NEVER
 * re-sealed), plan rows, apply into catalog + engine home, idempotence.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MCP_GATEWAY_MASTER_KEY = '77'.repeat(32)

const { planMigration, applyMigration } = await import('../dist/config/legacy-import.js')
const { readLegacyGateway } = await import('../dist/config/legacy-read.js')
const { readCatalog, globalCatalogPath } = await import('../dist/config/native-catalog.js')
const { writeSecureJson } = await import('../dist/engine/secure/statefile.js')

function legacyDir() {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-legacy-'))
  mkdirSync(dir, { recursive: true })
  // gateway.config.json: SEALED (current format) with two servers
  writeSecureJson(join(dir, 'gateway.config.json'), {
    port: 19999, host: '127.0.0.1', tokenEnv: 'MCP_GATEWAY_TOKEN',
    servers: {
      'db-main': { type: 'mysql', host: '10.0.0.9', user: 'app', password: 'pw', database: 'prod' },
      echo: { type: 'echo' },
    },
  })
  // managed.json: LEGACY PLAINTEXT (pre-encryption install) — the read-only proof
  writeFileSync(join(dir, 'managed.json'), JSON.stringify({
    mcps: [{ name: 'extra', def: { type: 'redis', host: '127.0.0.1' }, enabled: false }],
    tokens: [{ id: 'default', label: 'default', secret: 'tok123', createdAt: '' }],
  }))
  // tunnels.json: sealed
  writeSecureJson(join(dir, 'tunnels.json'), {
    connections: [{ id: 'c1', name: 'bastion', host: '10.0.0.1', port: 22, username: 'u', authType: 'password', password: 'x' }],
    rules: [{ id: 'r1', name: 'db', connectionId: 'c1', localPort: 15432, targetHost: 'db', targetPort: 5432, autoReconnect: true, reconnectInterval: 10, enabled: true, mcps: [] }],
  })
  // env.json: sealed
  writeSecureJson(join(dir, 'env.json'), { MCP_GATEWAY_TOKEN: 'seed-token' })
  return dir
}

test('migration: read-only pre-check never rewrites plaintext; plan + apply + idempotence', async (t) => {
  const legacy = legacyDir()
  t.after(() => rmSync(legacy, { recursive: true, force: true }))
  const storage = mkdtempSync(join(tmpdir(), 'mcp-mig-target-'))
  t.after(() => rmSync(storage, { recursive: true, force: true }))

  const managedBefore = readFileSync(join(legacy, 'managed.json'), 'utf8')

  // --- plan (dry-run) ---
  const plan = await planMigration(legacy, storage)
  assert.deepEqual(plan.legacyPlain, [join(legacy, 'managed.json')], 'plaintext source flagged')
  assert.deepEqual(plan.undecryptable, [])
  const names = (kind) => plan.rows.filter((r) => r.kind === kind).map((r) => r.name)
  assert.deepEqual(names('mcp').sort(), ['db-main', 'echo', 'extra'])
  assert.deepEqual(names('tunnel'), ['db'])
  assert.ok(names('env').includes('MCP_GATEWAY_TOKEN'))
  assert.ok(names('token').includes('default'))
  assert.equal(plan.rows.find((r) => r.kind === 'mcp' && r.name === 'extra')?.action, 'import')

  // read-only proof: the plaintext file is byte-identical after planning
  assert.equal(readFileSync(join(legacy, 'managed.json'), 'utf8'), managedBefore, 'P6.2: pre-check never rewrites')

  // --- apply ---
  const applied = await applyMigration(plan, storage)
  assert.deepEqual(applied.mcps.sort(), ['db-main', 'echo', 'extra'])
  assert.deepEqual(applied.files.sort(), ['env.json', 'managed.json', 'tunnels.json'])

  // catalog holds the servers; the disabled flag survived
  const { catalog } = await readCatalog(globalCatalogPath(storage))
  assert.deepEqual(Object.keys(catalog.entries).sort(), ['db-main', 'echo', 'extra'])
  assert.equal(catalog.entries['extra']?.enabled, false, 'disabled state carried')

  // engine home got re-sealed copies (not plaintext)
  for (const f of ['tunnels.json', 'env.json', 'managed.json']) {
    const raw = readFileSync(join(storage, 'engine', f), 'utf8')
    assert.equal(JSON.parse(raw).lmg, 1, f + ' re-sealed')
    assert.ok(!raw.includes('seed-token') || f === 'x', 'no plaintext secret')
  }

  // --- idempotence: re-plan says keep, re-apply imports nothing new ---
  const plan2 = await planMigration(legacy, storage)
  assert.equal(plan2.rows.find((r) => r.kind === 'mcp' && r.name === 'db-main')?.action, 'keep')
  const applied2 = await applyMigration(plan2, storage)
  assert.deepEqual(applied2.mcps, [])
  assert.deepEqual(applied2.files, [], 'engine files exist -> kept, not overwritten')
})

test('migration: a foreign-machine envelope reports undecryptable, nothing written', async (t) => {
  const legacy = mkdtempSync(join(tmpdir(), 'mcp-legacy2-'))
  t.after(() => rmSync(legacy, { recursive: true, force: true }))
  const storage = mkdtempSync(join(tmpdir(), 'mcp-mig2-'))
  t.after(() => rmSync(storage, { recursive: true, force: true }))
  // an envelope sealed under a DIFFERENT key
  process.env.MCP_GATEWAY_MASTER_KEY = 'aa'.repeat(32)
  writeSecureJson(join(legacy, 'gateway.config.json'), { servers: { x: { type: 'echo' } } })
  process.env.MCP_GATEWAY_MASTER_KEY = '77'.repeat(32)
  const plan = await planMigration(legacy, storage)
  assert.equal(plan.undecryptable.length, 1)
  assert.equal(plan.rows.filter((r) => r.kind === 'mcp').length, 0, 'nothing importable')
  assert.ok(!existsSync(join(storage, 'catalog', 'global.json')), 'no target writes')
})

test('migration: a booted target engine merges env per key and tokens by id (never whole-file skip)', async (t) => {
  const legacy = legacyDir()
  t.after(() => rmSync(legacy, { recursive: true, force: true }))
  const storage = mkdtempSync(join(tmpdir(), 'mcp-mig3-'))
  t.after(() => rmSync(storage, { recursive: true, force: true }))

  // a plugin engine that already booted: its own env.json (different key) and
  // managed.json (its own default token) exist — the whole-file copy must NOT run
  mkdirSync(join(storage, 'engine'), { recursive: true })
  writeSecureJson(join(storage, 'engine', 'env.json'), { MCP_GATEWAY_TOKEN: 'plugin-token' })
  writeSecureJson(join(storage, 'engine', 'managed.json'), { mcps: [], tokens: [{ id: 'default', label: 'default', secret: 'plugin', createdAt: '' }] })

  const plan = await planMigration(legacy, storage)
  const applied = await applyMigration(plan, storage)

  // env: every legacy key already exists in the plugin store -> nothing added,
  // and the plugin's own value survived untouched
  assert.ok(applied.skipped.some((s) => s.startsWith('env.json')), 'env reported: ' + JSON.stringify(applied.skipped))
  const { readSecureJson } = await import('../dist/engine/secure/statefile.js')
  const env = readSecureJson(join(storage, 'engine', 'env.json'))
  assert.equal(env.MCP_GATEWAY_TOKEN, 'plugin-token', 'existing key wins')

  // tokens: the legacy token list (default) is known by id -> nothing added;
  // the plugin's own managed entry is intact
  assert.ok(applied.skipped.some((s) => s.startsWith('managed.json')), 'managed reported: ' + JSON.stringify(applied.skipped))
  const managed = readSecureJson(join(storage, 'engine', 'managed.json'))
  assert.deepEqual(managed.tokens.map((x) => x.id), ['default'])
  assert.equal(managed.tokens[0].secret, 'plugin', 'engine-owned token never clobbered')

  // tunnels: target absent -> whole-file copy still happens
  assert.ok(applied.files.includes('tunnels.json'), 'tunnels copied')

  // and the same legacy env re-applied converges (nothing new)
  const applied2 = await applyMigration(await planMigration(legacy, storage), storage)
  assert.ok(applied2.skipped.some((s) => s.startsWith('env.json')), 'second apply adds no keys')
})

test('migration: a booted target engine gains missing env keys and unknown tokens', async (t) => {
  const legacy = legacyDir()
  // legacy env gains a key the plugin does not have, and managed.json a token id it does not know
  const { readSecureJson } = await import('../dist/engine/secure/statefile.js')
  void readSecureJson
  const { writeSecureJson: seal } = await import('../dist/engine/secure/statefile.js')
  seal(join(legacy, 'env.json'), { MCP_GATEWAY_TOKEN: 'seed-token', SEARCH_API_KEY: 'k-1' })
  const mng = JSON.parse(readFileSync(join(legacy, 'managed.json'), 'utf8'))
  mng.tokens.push({ id: 'dsh-9', label: 'dsh', secret: 'old-secret', createdAt: '' })
  writeFileSync(join(legacy, 'managed.json'), JSON.stringify(mng))

  const storage = mkdtempSync(join(tmpdir(), 'mcp-mig4-'))
  t.after(() => rmSync(storage, { recursive: true, force: true }))
  mkdirSync(join(storage, 'engine'), { recursive: true })
  seal(join(storage, 'engine', 'env.json'), { MCP_GATEWAY_TOKEN: 'plugin-token' })
  seal(join(storage, 'engine', 'managed.json'), { mcps: [], tokens: [{ id: 'default', label: 'default', secret: 'plugin', createdAt: '' }] })

  const applied = await applyMigration(await planMigration(legacy, storage), storage)
  assert.ok(applied.files.some((f) => f === 'env.json (+1 keys)'), 'exactly the missing key added: ' + JSON.stringify(applied.files))
  const env = readSecureJson(join(storage, 'engine', 'env.json'))
  assert.equal(env.SEARCH_API_KEY, 'k-1')
  assert.equal(env.MCP_GATEWAY_TOKEN, 'plugin-token')
  assert.ok(applied.files.some((f) => f === 'managed.json (+1 tokens)'), 'unknown token imported: ' + JSON.stringify(applied.files))
  const managed = readSecureJson(join(storage, 'engine', 'managed.json'))
  assert.deepEqual(managed.tokens.map((x) => x.id).sort(), ['default', 'dsh-9'])
})

test('migration: an unreadable target is kept, not an exception that halts a half-applied migration', async (t) => {
  const legacy = legacyDir()
  const storage = mkdtempSync(join(tmpdir(), 'mcp-store-unreadable-'))
  t.after(() => { rmSync(legacy, { recursive: true, force: true }); rmSync(storage, { recursive: true, force: true }) })

  // Targets that EXIST but cannot be read: corrupt JSON here, a seal made with another machine's
  // key in the field. readSecureJson throws for both -- and by the time these merges run, step 1
  // has already written the native catalog, so an escaping error leaves the migration half done.
  mkdirSync(join(storage, 'engine'), { recursive: true })
  writeFileSync(join(storage, 'engine', 'env.json'), '{ this is not json')
  writeFileSync(join(storage, 'engine', 'managed.json'), '{ neither is this')

  const applied = await applyMigration(await planMigration(legacy, storage), storage)
  assert.ok(applied.mcps.length > 0, 'step 1 still landed: ' + JSON.stringify(applied))
  assert.ok(applied.skipped.some((s) => s.startsWith('env.json')), 'env.json kept: ' + JSON.stringify(applied.skipped))
  assert.ok(applied.skipped.some((s) => s.startsWith('managed.json')), 'managed.json kept: ' + JSON.stringify(applied.skipped))
  assert.equal(readFileSync(join(storage, 'engine', 'env.json'), 'utf8'), '{ this is not json', 'left untouched')
})
