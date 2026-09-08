/** session bridge pure helpers: names, text projection, connection keys. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { publicNameLite, extractTextLite, configKey, isConnectionError, scrubbedEnvLite } from '../dist/session.js'

test('publicNameLite passes through short sane names', () => {
  assert.equal(publicNameLite('mysql', 'query'), 'mcp__mysql__query')
  assert.equal(publicNameLite('a-b_C9', 'tool_name-1'), 'mcp__a-b_C9__tool_name-1')
})

test('publicNameLite normalizes lossy characters', () => {
  const name = publicNameLite('mysql', 'query.v2')
  assert.ok(name.startsWith('mcp__mysql__query_v2'))
})

test('publicNameLite appends a stable hash suffix for long names', () => {
  const rawTool = 't'.repeat(80)
  const name = publicNameLite('mysql', rawTool)
  assert.ok(name.length <= 64, 'name stays within the 64-char budget')
  assert.match(name, /_[0-9a-f]{12}$/, 'ends with a 12-hex identity suffix')
  assert.equal(name, publicNameLite('mysql', rawTool), 'suffix is deterministic')
  assert.notEqual(name, publicNameLite('other', rawTool), 'suffix binds the server name')
})

test('extractTextLite projects every content kind', () => {
  assert.equal(extractTextLite([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'ab')
  assert.equal(extractTextLite([{ type: 'image', mimeType: 'image/png' }]), '[image: image/png, content discarded]')
  assert.equal(extractTextLite([{ type: 'audio' }]), '[audio: unknown, content discarded]')
  assert.equal(extractTextLite([{ type: 'resource' }]), '[resource: content discarded]')
  assert.equal(extractTextLite([{ type: 'resource_link' }]), '[resource: content discarded]')
  assert.equal(extractTextLite([{ type: 'weird' }]), '[unsupported content type: weird]')
  assert.equal(extractTextLite([null]), '[unsupported content type: null]')
})

test('configKey is stable per transport identity and sensitive to fields', () => {
  const httpA = { transport: 'streamable-http', url: 'http://a/mcp', headers: { Authorization: 'Bearer x' } }
  const httpACopy = { transport: 'http-alias', url: 'http://a/mcp', headers: { Authorization: 'Bearer x' } }
  const httpB = { transport: 'streamable-http', url: 'http://b/mcp', headers: { Authorization: 'Bearer x' } }
  const httpAuth = { transport: 'streamable-http', url: 'http://a/mcp', headers: { Authorization: 'Bearer y' } }
  const stdio = { transport: 'stdio', command: 'npx', args: ['-y', 'x'], env: {}, cwd: '/w' }
  const stdioEnv = { transport: 'stdio', command: 'npx', args: ['-y', 'x'], env: { K: 'v' }, cwd: '/w' }
  assert.equal(configKey(httpA), configKey(httpACopy), 'only the defining fields matter')
  assert.notEqual(configKey(httpA), configKey(httpB))
  assert.notEqual(configKey(httpA), configKey(httpAuth))
  assert.notEqual(configKey(httpA), configKey(stdio))
  assert.notEqual(configKey(stdio), configKey(stdioEnv))
  assert.match(configKey(httpA), /^[0-9a-f]{64}$/, 'sha256 hex digest')
})

test('isConnectionError recognizes closure shapes only', () => {
  const closed = Object.assign(new Error('x'), { code: -32000 })
  assert.equal(isConnectionError(closed), true)
  assert.equal(isConnectionError(new Error('Not connected')), true)
  assert.equal(isConnectionError(new Error('Fetch failed')), true)
  assert.equal(isConnectionError(new Error('tool said no')), false)
  assert.equal(isConnectionError(null), false)
})

test('scrubbedEnvLite drops credential-shaped and DSH_ names', () => {
  process.env.SCRUB_TEST_SECRET = 's'
  process.env.DSH_SCRUB_TEST_DSH = 'd'
  process.env.SCRUB_TEST_PLAIN = 'p'
  try {
    const env = scrubbedEnvLite()
    assert.equal(env.SCRUB_TEST_SECRET, undefined)
    assert.equal(env.DSH_SCRUB_TEST_DSH, undefined)
    assert.equal(env.SCRUB_TEST_PLAIN, 'p')
  } finally {
    delete process.env.SCRUB_TEST_SECRET
    delete process.env.DSH_SCRUB_TEST_DSH
    delete process.env.SCRUB_TEST_PLAIN
  }
})
