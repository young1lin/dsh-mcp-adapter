/** settings projection: patch base <-> GUI section round-trips. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { projectGatewayEntry, gatewayConfigFrom } from '../dist/settings.js'
import { resolveGatewayConfig } from '../dist/gateway.js'

test('a null gateway projects to the disabled defaults', () => {
  assert.deepEqual(projectGatewayEntry(null), {
    enabled: false,
    lifecycle: 'external',
    url: '',
    groups: '',
    include: '',
    exclude: '',
    tokenLabel: 'dsh',
    required: false,
  })
})

test('a configured gateway projects its shape (default url stays blank)', () => {
  const entry = projectGatewayEntry(resolveGatewayConfig(true))
  assert.equal(entry.enabled, true)
  assert.equal(entry.lifecycle, 'external')
  assert.equal(entry.url, '', 'the default origin composes from the schema default')
  const custom = projectGatewayEntry(resolveGatewayConfig({ url: 'http://127.0.0.1:20000', groups: ['a', 'b'], embed: true }))
  assert.equal(custom.url, 'http://127.0.0.1:20000')
  assert.equal(custom.groups, 'a, b')
  assert.equal(custom.lifecycle, 'embedded')
})

test('a disabled section resolves to null regardless of patch config', () => {
  assert.equal(gatewayConfigFrom({ enabled: false }, resolveGatewayConfig(true)), null)
  assert.equal(gatewayConfigFrom(undefined, resolveGatewayConfig(true)), null)
})

test('section round-trips through the resolver with list parsing', () => {
  const resolved = gatewayConfigFrom(
    { enabled: true, url: ' http://127.0.0.1:20000 ', groups: 'a, b,,', include: 'mysql', exclude: ' echo ,', tokenLabel: 'custom', required: true },
    null,
  )
  assert.equal(resolved.url, 'http://127.0.0.1:20000')
  assert.deepEqual(resolved.groups, ['a', 'b'])
  assert.deepEqual(resolved.include, ['mysql'])
  assert.deepEqual(resolved.exclude, ['echo'])
  assert.equal(resolved.tokenLabel, 'custom')
  assert.equal(resolved.required, true)
})

test('embedded lifecycle carries the patch embed block through', () => {
  const patch = resolveGatewayConfig({ embed: { respawn: false, leaveRunning: true } })
  const resolved = gatewayConfigFrom({ enabled: true, lifecycle: 'embedded' }, patch)
  assert.notEqual(resolved.embed, null)
  assert.equal(resolved.embed.respawn, false)
  assert.equal(resolved.embed.leaveRunning, true)
  // Without a patch block, embed falls back to the plain 'true' defaults.
  const fromScratch = gatewayConfigFrom({ enabled: true, lifecycle: 'embedded' }, null)
  assert.equal(fromScratch.embed.respawn, true)
  assert.equal(fromScratch.embed.leaveRunning, false)
})

test('patch-only keys survive the GUI compose', () => {
  const patch = resolveGatewayConfig({ token: 'sekrit', fetchTimeoutMs: 1500, autostart: true })
  const resolved = gatewayConfigFrom({ enabled: true }, patch)
  assert.equal(resolved.token, 'sekrit')
  assert.equal(resolved.fetchTimeoutMs, 1500)
  assert.deepEqual(resolved.autostart, { command: 'npx', args: ['-y', 'local-mcp-gateway', 'start'], timeoutMs: 20000 })
  const withoutPatch = gatewayConfigFrom({ enabled: true }, null)
  assert.equal(withoutPatch.token, undefined)
  assert.equal(withoutPatch.fetchTimeoutMs, 5000)
})

test('projection round-trip of an enabled external gateway is lossless', () => {
  const patch = resolveGatewayConfig({ groups: ['x'] })
  const section = projectGatewayEntry(patch)
  const back = gatewayConfigFrom(section, patch)
  assert.equal(back.url, patch.url)
  assert.deepEqual(back.groups, ['x'])
  assert.equal(back.embed, null)
})
