import { test } from 'node:test'
import assert from 'node:assert/strict'
import { snapshotView, configurationChanges } from '../dist/host/session-view.js'
import { registeredServers } from '../dist/client/session-snapshot.js'

const frozen = servers => ({ version: 2, workspaceId: 'ws', configRevision: 'r', registeredAt: 'registered', servers })
const server = (logical, def, tools = [{ name: 'query', description: 'Frozen description', inputSchema: { privateDefault: 'private-fixture' } }]) => ({ logical, instance: 'private-instance', def, tools })
const entry = (name, def, source = 'native', disabled = false) => ({ name, def, source, disabled })

test('session DTO projects frozen groups without defs, headers, env, schemas or instance ids', () => {
  const snap = frozen([server('foo__bar', { type: 'http', url: 'https://user:private-fixture@host/mcp', headers: { Authorization: 'private-fixture' } }), server('local', { type: 'proc', command: 'node private-fixture', env: { TOKEN: 'private-fixture' } })])
  const dto = snapshotView(snap)
  assert.equal(dto.servers[0].name, 'foo__bar')
  assert.equal(dto.servers[0].transport, 'http')
  assert.equal(dto.servers[1].transport, 'stdio')
  assert.equal(dto.tools.length, 2)
  assert.equal(JSON.stringify(dto).includes('private-fixture'), false)
  assert.equal(JSON.stringify(dto).includes('private-instance'), false)
  assert.equal(dto.servers[0].tools[0].description, 'Frozen description')
  assert.deepEqual(registeredServers(dto), dto.servers, 'explicit logical names, not split public identifiers')
})

test('session view never substitutes latest config for absent, empty or unsafe snapshots', () => {
  assert.deepEqual(registeredServers(), [])
  assert.deepEqual(registeredServers({ revision: 'r', registeredAt: 'at', tools: ['mcp__new__query'], servers: [] }), [])
  assert.deepEqual(registeredServers({ revision: 'r', registeredAt: 'at', tools: ['mcp__old__query'], restorable: false }), [])
})

test('older flat DTO groups its recorded identifiers without guessing current transport', () => {
  const groups = registeredServers({ revision: 'r', registeredAt: 'at', tools: ['mcp__old__query', 'mcp__old__read', 'mcp__another__ping'] })
  assert.equal(groups.length, 2)
  assert.equal(groups[0].transport, 'other')
  assert.deepEqual(groups[0].tools.map(tool => tool.name), ['query', 'read'])
})

test('drift compares frozen definitions, not file revisions or current tool names', () => {
  const snap = frozen([server('same', { type: 'http', url: 'https://host/mcp', headers: { B: '2', A: '1' } })])
  assert.deepEqual(configurationChanges(snap, { entries: [entry('same', { headers: { A: '1', B: '2' }, url: 'https://host/mcp', type: 'http' })] }), { added: 0, removed: 0, changed: 0 })
  assert.deepEqual(configurationChanges(snap, { entries: [entry('same', { url: 'https://changed/mcp', type: 'http' }), entry('added', { type: 'echo' })] }), { added: 1, removed: 0, changed: 1 })
  assert.deepEqual(configurationChanges(snap, { entries: [entry('same', { type: 'http' }, 'native', true)] }), { added: 0, removed: 1, changed: 0 })
})

test('drift converts standard carriers to the same engine definition before comparing', () => {
  const snap = frozen([server('local', { type: 'proc', command: 'node server.mjs', env: { TOKEN: 'private-fixture' } })])
  const next = { entries: [entry('local', { command: 'node', args: ['server.mjs'], env: { TOKEN: 'private-fixture' } }, 'standard')] }
  assert.deepEqual(configurationChanges(snap, next), { added: 0, removed: 0, changed: 0 })
})
