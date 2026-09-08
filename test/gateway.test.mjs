/** gateway: config validation, discovery via fetch stub, token order. */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveGatewayConfig, resolveBearerToken, discoverGateway, DEFAULT_GATEWAY_URL } from '../dist/gateway.js'
import { putSecret } from '../dist/sealed.js'

// Isolate the sealed store per test run so token order is deterministic.
let dshHome
const realFetch = globalThis.fetch

beforeEach(() => {
  dshHome = mkdtempSync(join(tmpdir(), 'dsh-mcp-gw-'))
  process.env.DSH_HOME = dshHome
})

afterEach(() => {
  delete process.env.DSH_HOME
  delete process.env.MCP_GATEWAY_TOKEN
  globalThis.fetch = realFetch
  rmSync(dshHome, { recursive: true, force: true })
})

function res(status, body) {
  return { status, json: async () => body }
}

/** Route table stub: [pattern, handler]; unmatched URLs throw. */
function stubFetch(routes, log = []) {
  globalThis.fetch = async (url, init) => {
    log.push(String(url))
    for (const [pattern, handler] of routes) {
      if (pattern.test(String(url))) return handler(url, init)
    }
    throw new Error('unexpected fetch ' + url)
  }
}

test('resolveGatewayConfig defaults', () => {
  const cfg = resolveGatewayConfig(true)
  assert.equal(cfg.url, DEFAULT_GATEWAY_URL)
  assert.deepEqual(cfg.groups, [])
  assert.equal(cfg.tokenEnv, 'MCP_GATEWAY_TOKEN')
  assert.equal(cfg.tokenLabel, 'dsh')
  assert.equal(cfg.createToken, true)
  assert.equal(cfg.autostart, null)
  assert.equal(cfg.embed, null)
  assert.equal(cfg.required, false)
  assert.equal(cfg.fetchTimeoutMs, 5000)
  assert.equal(resolveGatewayConfig(undefined), null)
  assert.equal(resolveGatewayConfig(false), null)
})

test('resolveGatewayConfig normalizes url to origin and validates keys', () => {
  const cfg = resolveGatewayConfig({ url: 'http://127.0.0.1:20000/path?q=1' })
  assert.equal(cfg.url, 'http://127.0.0.1:20000')
  assert.throws(() => resolveGatewayConfig({ nope: 1 }), /unknown gateway config key/)
  assert.throws(() => resolveGatewayConfig({ embed: { nope: 1 } }), /unknown gateway.embed key/)
  assert.throws(() => resolveGatewayConfig({ autostart: { nope: 1 } }), /unknown gateway.autostart key/)
  assert.throws(() => resolveGatewayConfig({ tokenEnv: 'not a name' }), /must be an environment variable name/)
})

test('resolveGatewayConfig autostart defaults to the lmg recipe', () => {
  const cfg = resolveGatewayConfig({ autostart: true })
  assert.deepEqual(cfg.autostart, { command: 'npx', args: ['-y', 'local-mcp-gateway', 'start'], timeoutMs: 20000 })
  const custom = resolveGatewayConfig({ autostart: { command: 'lmg', args: ['start'], timeoutMs: 5000 } })
  assert.deepEqual(custom.autostart, { command: 'lmg', args: ['start'], timeoutMs: 5000 })
})

test('resolveGatewayConfig embed defaults', () => {
  const cfg = resolveGatewayConfig({ embed: true })
  assert.deepEqual(cfg.embed, { respawn: true, leaveRunning: false })
  const off = resolveGatewayConfig({ embed: { respawn: false, leaveRunning: true, entry: 'x.js' } })
  assert.equal(off.embed.respawn, false)
  assert.equal(off.embed.leaveRunning, true)
  assert.equal(off.embed.entry, 'x.js')
})

test('token order: explicit config token wins without any fetch', async () => {
  const calls = []
  stubFetch([[/^/, () => res(200, {})]], calls)
  const token = await resolveBearerToken(resolveGatewayConfig({ token: 'cfg-token' }))
  assert.equal(token, 'cfg-token')
  assert.deepEqual(calls, [])
})

test('token order: sealed store beats env and the api', async () => {
  putSecret('gateway-token', 'sealed-token')
  process.env.MCP_GATEWAY_TOKEN = 'env-token'
  stubFetch([[/^http:.*\/api\/tokens$/, () => res(200, { tokens: [{ id: 't1', label: 'dsh' }] })]])
  const token = await resolveBearerToken(resolveGatewayConfig(true))
  assert.equal(token, 'sealed-token')
})

test('token order: env beats the api when nothing is sealed', async () => {
  process.env.MCP_GATEWAY_TOKEN = 'env-token'
  const calls = []
  stubFetch([[/^http:.*\/api\/tokens$/, () => res(200, { tokens: [{ id: 't1', label: 'dsh' }] })]], calls)
  const token = await resolveBearerToken(resolveGatewayConfig(true))
  assert.equal(token, 'env-token')
  assert.deepEqual(calls, [])
})

test('token order: labeled api token fetched through its secret endpoint', async () => {
  stubFetch([
    [/^http:.*\/api\/tokens$/, () => res(200, { tokens: [{ id: 't1', label: 'dsh' }, { id: 't0', label: 'default' }] })],
    [/^http:.*\/api\/tokens\/t1\/secret$/, () => res(200, { secret: 'api-token' })],
  ])
  const token = await resolveBearerToken(resolveGatewayConfig(true))
  assert.equal(token, 'api-token')
})

test('token order: missing label is auto-created, then falls back to default', async () => {
  stubFetch([
    [/^http:.*\/api\/tokens$/, (url, init) => {
      if (init?.method === 'POST') return res(201, { secret: 'created-token' })
      return res(200, { tokens: [{ id: 't0', label: 'default' }] })
    }],
  ])
  const created = await resolveBearerToken(resolveGatewayConfig(true))
  assert.equal(created, 'created-token')

  const noCreate = resolveGatewayConfig({ createToken: false })
  stubFetch([
    [/^http:.*\/api\/tokens$/, () => res(200, { tokens: [{ id: 't0', label: 'default' }] })],
    [/^http:.*\/api\/tokens\/t0\/secret$/, () => res(200, { secret: 'default-token' })],
  ])
  assert.equal(await resolveBearerToken(noCreate), 'default-token')
})

test('discoverGateway returns null when unreachable (and logs)', async () => {
  stubFetch([[/^http:.*\/health$/, () => { throw new Error('down') }]])
  const lines = []
  const plan = await discoverGateway(resolveGatewayConfig(true), (line) => lines.push(line))
  assert.equal(plan, null)
  assert.ok(lines.some((line) => line.includes('gateway not reachable')))
})

test('discoverGateway throws when required and unreachable', async () => {
  stubFetch([[/^http:.*\/health$/, () => { throw new Error('down') }]])
  await assert.rejects(
    () => discoverGateway(resolveGatewayConfig({ required: true }), () => {}),
    /gateway not reachable/,
  )
})

test('discoverGateway mounts the api list with filters applied', async () => {
  stubFetch([
    [/^http:.*\/health$/, () => res(200, { ok: true })],
    [/^http:.*\/api\/tokens$/, () => res(200, { tokens: [{ id: 't1', label: 'dsh' }] })],
    [/^http:.*\/api\/tokens\/t1\/secret$/, () => res(200, { secret: 's1' })],
    [/^http:.*\/api\/mcps$/, () => res(200, { mcps: [
      { name: 'mysql', group: 'databases' },
      { name: 'echo', group: 'misc' },
      { name: 'this-name-is-way-longer-than-thirty-two-chars', group: 'misc' },
      { name: 'files', group: 'misc' },
    ] })],
  ])
  const lines = []
  const plan = await discoverGateway(resolveGatewayConfig({ exclude: ['echo'] }), (line) => lines.push(line))
  assert.equal(plan.configs.length, 2)
  const names = plan.configs.map((c) => c.serverName)
  assert.deepEqual(names.sort(), ['files', 'mysql'])
  for (const config of plan.configs) {
    assert.equal(config.transport, 'streamable-http')
    assert.equal(config.headers.Authorization, 'Bearer s1')
    assert.ok(config.url.startsWith('http://127.0.0.1:19999/'))
  }
  assert.ok(plan.skipped.some((entry) => entry.startsWith('echo (excluded)')))
  assert.ok(plan.skipped.some((entry) => entry.includes('this-name-is-way-longer')))
  assert.ok(lines.some((line) => line.includes('gateway skipped')))

  const grouped = await discoverGateway(resolveGatewayConfig({ groups: ['databases'] }), () => {})
  assert.deepEqual(grouped.configs.map((c) => c.serverName), ['mysql'])
})
