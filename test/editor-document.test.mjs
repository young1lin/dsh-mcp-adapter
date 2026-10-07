import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readEditorDocument } from '../dist/client/editor-document.js'
import { typeOfDef, fieldsFor } from '../dist/client/fields.js'
import { tokenizeCommand } from '../dist/engine/adapters/proc.js'

const http = { type: 'http', url: 'https://example.invalid/mcp/mongo', headers: { Authorization: 'Bearer fixture-only' }, custom: { keep: true } }
test('editor JSON: mcpServers selects only first HTTP definition and returns its name', () => {
  const input = { mcpServers: { mongo: http, ignored: { command: 'other' } }, otherRoot: 'never part of def' }
  const doc = readEditorDocument(JSON.stringify(input))
  assert.deepEqual(doc, { name: 'mongo', count: 2, def: http })
  assert.equal(typeOfDef(doc.def, 'global:standard'), 'remote')
  assert.equal(fieldsFor('remote').some((f) => f.k === 'headers'), true)
  assert.deepEqual(readEditorDocument(JSON.stringify(input), true).def, http)
})

test('editor JSON: stdio maps to native proc with real Windows/UNC/quoted args intact', () => {
  const bs = String.fromCharCode(92)
  const command = ['C:', 'Program Files', 'nodejs', 'node.exe'].join(bs)
  const args = ['a"b', ['C:', 'my project', 'server.mjs'].join(bs), bs.repeat(2) + ['server', 'share', ''].join(bs)]
  const def = { type: 'stdio', command, args, env: { TOKEN: 'fixture-only' }, cwd: 'C:/project', custom: 42 }
  const json = JSON.stringify({ mcpServers: { local: def } })
  assert.deepEqual(readEditorDocument(json).def, def)
  const native = readEditorDocument(json, true)
  assert.equal(native.name, 'local')
  assert.equal(native.def.type, 'proc')
  assert.deepEqual(tokenizeCommand(native.def.command), [command, ...args])
  assert.equal(Object.hasOwn(native.def, 'args'), false, 'native proc must not silently ignore args')
  assert.deepEqual(native.def.env, def.env)
  assert.equal(native.def.cwd, def.cwd)
  assert.equal(native.def.custom, 42)
})

test('editor JSON: bare command/URL definitions stay supported; native carrier fills only its type', () => {
  const stdio = { command: 'npx', args: ['-y', 'pkg'], disabled: true }
  assert.deepEqual(readEditorDocument(JSON.stringify(stdio)).def, stdio)
  assert.deepEqual(readEditorDocument(JSON.stringify(stdio), true).def, { type: 'proc', command: 'npx -y pkg', disabled: true })
  const remote = { url: http.url, headers: http.headers }
  assert.deepEqual(readEditorDocument(JSON.stringify(remote), true).def, { ...remote, type: 'http' })
})

test('editor JSON: an explicit native proc keeps its COMPLETE inline command, options and secrets', () => {
  const def = { type: 'proc', command: '/usr/bin/node server.mjs', env: { TOKEN: '••••••••' }, timeoutMs: 9000, idleMs: 60000 }
  assert.deepEqual(readEditorDocument(JSON.stringify(def), true), { def })
})

test('editor JSON: untyped legacy inline command is not quoted as a single executable', () => {
  const def = { command: '/usr/bin/node server.mjs', env: { TOKEN: '••••••••' } }
  assert.deepEqual(readEditorDocument(JSON.stringify(def), true).def, { ...def, type: 'proc' })
})

test('editor JSON: empty/bad maps and bad first child do not fall through to a healthy second server', () => {
  for (const map of [null, [], 42]) assert.equal(readEditorDocument(JSON.stringify({ mcpServers: map })).error, 'editorJsonBadMap')
  assert.equal(readEditorDocument('{"mcpServers":{}}').error, 'editorJsonEmptyMap')
  for (const entry of [null, [], 'bad']) assert.equal(readEditorDocument(JSON.stringify({ mcpServers: { bad: entry, good: http } })).error, 'editorJsonBadEntry')
  for (const json of ['{', 'null', '42', '[]']) assert.equal(readEditorDocument(json), undefined)
})

test('editor fields: standard HTTP/stdio type tags use the standard carrier schemas', () => {
  for (const layer of ['global:standard', 'global:claude', 'project:root', 'project:claude']) {
    assert.equal(typeOfDef({ type: 'http', url: http.url }, layer), 'remote')
    assert.equal(typeOfDef({ type: 'sse' }, layer), 'remote')
    assert.equal(typeOfDef({ type: 'stdio', command: 'npx' }, layer), 'stdio')
    assert.equal(typeOfDef({ type: 'proc', command: 'node full.mjs' }, layer), 'proc', 'legacy complete proc command keeps its no-args schema')
  }
  assert.equal(typeOfDef(http, 'global:native'), 'http')
})
