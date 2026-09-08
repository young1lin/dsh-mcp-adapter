
test('disabled file entries are skipped with their names carried (tombstone survives discovery)', async () => {
  const { planServers } = await import('../dist/plan.js')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mcp-skip-'))
  try {
    const file = join(dir, '.mcp.json')
    writeFileSync(file, JSON.stringify({ mcpServers: { deadone: { command: 'node x.js', disabled: true }, alive: { command: 'node y.js' } } }))
    const plan = await planServers(
      { projectRoot: dir, disable: new Set(), failOnStartupError: false },
      [file],
      () => {},
    )
    assert.deepEqual(plan.skipped, ['deadone'], 'disabled name surfaces in skipped (feeds the discovery dedup)')
    assert.equal(plan.configs.length, 1)
    assert.equal(plan.configs[0].serverName, 'alive')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
/** planServers: layer merge, entry validation, env expansion, mappings. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planServers, readServerFile } from '../dist/plan.js'

function tmp() {
  return mkdtempSync(join(tmpdir(), 'dsh-mcp-plan-'))
}

const baseOptions = (dir, disable = []) => ({
  projectRoot: dir,
  disable: new Set(disable),
  failOnStartupError: false,
})

test('missing files are a normal empty layer', async () => {
  const dir = tmp()
  try {
    const plan = await planServers(baseOptions(dir), [join(dir, 'a.json'), join(dir, 'b.json')], () => {})
    assert.deepEqual(plan.configs, [])
    assert.deepEqual(plan.skipped, [])
    assert.deepEqual(plan.overridden, [])
    assert.deepEqual(plan.loaded, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('later layers win per name and overrides are recorded', async () => {
  const dir = tmp()
  try {
    writeFileSync(join(dir, 'a.json'), JSON.stringify({ mcpServers: { mysql: { url: 'http://a/mysql' }, extra: { url: 'http://a/extra' } } }))
    writeFileSync(join(dir, 'b.json'), JSON.stringify({ mcpServers: { mysql: { url: 'http://b/mysql' } } }))
    const plan = await planServers(baseOptions(dir), [join(dir, 'a.json'), join(dir, 'b.json')], () => {})
    assert.equal(plan.configs.length, 2)
    const mysql = plan.configs.find((c) => c.serverName === 'mysql')
    assert.equal(mysql.url, 'http://b/mysql')
    assert.ok(plan.configs.some((c) => c.serverName === 'extra'))
    assert.deepEqual(plan.overridden, ['mysql'])
    assert.deepEqual(plan.loaded, [join(dir, 'a.json'), join(dir, 'b.json')])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('disabled entries and the disable list are skipped', async () => {
  const dir = tmp()
  try {
    writeFileSync(join(dir, 'a.json'), JSON.stringify({ mcpServers: {
      off: { url: 'http://a/off', disabled: true },
      listed: { url: 'http://a/listed' },
      on: { url: 'http://a/on' },
    } }))
    const plan = await planServers(baseOptions(dir, ['listed']), [join(dir, 'a.json')], () => {})
    assert.equal(plan.configs.length, 1)
    assert.equal(plan.configs[0].serverName, 'on')
    assert.deepEqual(plan.skipped.sort(), ['listed', 'off'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('stdio entries map with cwd and env expansion', async () => {
  const dir = tmp()
  try {
    process.env.DSH_MCP_PLAN_TEST_SET = 'hello'
    writeFileSync(join(dir, 'a.json'), JSON.stringify({ mcpServers: {
      local: {
        command: 'npx',
        args: ['-y', '@some/server'],
        env: { SET_VAR: '${DSH_MCP_PLAN_TEST_SET}', UNSET_VAR: '${DSH_MCP_PLAN_TEST_UNSET}' },
      },
    } }))
    const warnings = []
    const plan = await planServers(baseOptions(dir), [join(dir, 'a.json')], (line) => warnings.push(line))
    delete process.env.DSH_MCP_PLAN_TEST_SET
    assert.equal(plan.configs.length, 1)
    const config = plan.configs[0]
    assert.equal(config.transport, 'stdio')
    assert.equal(config.command, 'npx')
    assert.deepEqual(config.args, ['-y', '@some/server'])
    assert.equal(config.cwd, dir)
    assert.equal(config.env.SET_VAR, 'hello')
    assert.equal(config.env.UNSET_VAR, '${DSH_MCP_PLAN_TEST_UNSET}')
    assert.ok(warnings.some((line) => line.includes('DSH_MCP_PLAN_TEST_UNSET') && line.includes('unset')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('url entries map onto streamable-http with sse accepted', async () => {
  const dir = tmp()
  try {
    writeFileSync(join(dir, 'a.json'), JSON.stringify({ mcpServers: {
      remote: { type: 'sse', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } },
    } }))
    const plan = await planServers(baseOptions(dir), [join(dir, 'a.json')], () => {})
    assert.equal(plan.configs.length, 1)
    const config = plan.configs[0]
    assert.equal(config.transport, 'streamable-http')
    assert.equal(config.url, 'https://example.com/mcp')
    assert.deepEqual(config.headers, { Authorization: 'Bearer x' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('malformed files fail loud', async () => {
  const dir = tmp()
  try {
    writeFileSync(join(dir, 'bad.json'), '{ nope')
    await assert.rejects(() => readServerFile(join(dir, 'bad.json')), /is not valid JSON/)
    writeFileSync(join(dir, 'noservers.json'), '{"something": 1}')
    await assert.rejects(() => readServerFile(join(dir, 'noservers.json')), /has no "mcpServers" object/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('invalid entries refuse the whole mount with context', async () => {
  const dir = tmp()
  try {
    writeFileSync(join(dir, 'a.json'), JSON.stringify({ mcpServers: {
      both: { url: 'http://a/x', command: 'npx' },
      longname1234567890123456789012345678901: { url: 'http://a/y' },
    } }))
    await assert.rejects(
      () => planServers(baseOptions(dir), [join(dir, 'a.json')], () => {}),
      /refusing to mount MCP servers[\s\S]*both "url" and "command"[\s\S]*longname1234567890123456789012345678901/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('agents-dir project file is read when present', async () => {
  const dir = tmp()
  try {
    mkdirSync(join(dir, '.agents'))
    writeFileSync(join(dir, '.agents', '.mcp.json'), JSON.stringify({ mcpServers: { inner: { url: 'http://a/inner' } } }))
    const plan = await planServers(baseOptions(dir), [join(dir, '.mcp.json'), join(dir, '.agents', '.mcp.json')], () => {})
    assert.equal(plan.configs.length, 1)
    assert.equal(plan.configs[0].serverName, 'inner')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
