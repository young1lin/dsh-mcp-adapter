/** validateConfig: defaults, per-key validation, unknown keys. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { validateConfig } from '../dist/config.js'

test('defaults: no config yields process-mode with standard files', () => {
  const resolved = validateConfig(undefined)
  assert.equal(resolved.project, 'process')
  assert.equal(resolved.globalFile, join(homedir(), '.agents', '.mcp.json'))
  assert.equal(resolved.projectRoot, resolve(process.cwd()))
  assert.deepEqual(resolved.projectFiles, [
    join(resolve(process.cwd()), '.mcp.json'),
    join(resolve(process.cwd()), '.agents', '.mcp.json'),
  ])
  assert.deepEqual(resolved.disable, new Set())
  assert.equal(resolved.failOnStartupError, false)
  assert.equal(resolved.watch, false)
  assert.equal(resolved.engine, null)
  assert.equal(resolved.toolCallTimeoutMs, undefined)
})

test('config must be an object', () => {
  assert.throws(() => validateConfig([1, 2]), /config must be an object/)
  assert.throws(() => validateConfig('x'), /config must be an object/)
})

test('unknown config keys are rejected', () => {
  assert.throws(() => validateConfig({ nope: true }), /unknown config key "nope"/)
})

test('project must be process or session', () => {
  assert.throws(() => validateConfig({ project: 'workspace' }), /project must be "process" or "session"/)
  assert.equal(validateConfig({ project: 'session' }).project, 'session')
})

test('projectRoot must be a non-empty string', () => {
  assert.throws(() => validateConfig({ projectRoot: '' }), /projectRoot must be a non-empty string/)
  assert.throws(() => validateConfig({ projectRoot: 5 }), /projectRoot must be a non-empty string/)
})

test('globalFile must be a non-empty string', () => {
  assert.throws(() => validateConfig({ globalFile: '' }), /globalFile must be a non-empty string/)
})

test('projectFiles must be an array of non-empty paths and process-mode only', () => {
  assert.throws(() => validateConfig({ projectFiles: [''] }), /projectFiles must be an array of non-empty file paths/)
  assert.throws(() => validateConfig({ projectFiles: 'x' }), /projectFiles must be an array of non-empty file paths/)
  assert.throws(
    () => validateConfig({ project: 'session', projectFiles: ['a.json'] }),
    /projectFiles applies to project: process only/,
  )
  const resolved = validateConfig({ projectFiles: ['a.json', 'b.json'] })
  assert.deepEqual(resolved.projectFiles, [resolve('a.json'), resolve('b.json')])
})

test('projectFile pins a single project layer', () => {
  const resolved = validateConfig({ projectFile: 'custom.json' })
  assert.deepEqual(resolved.projectFiles, [resolve('custom.json')])
  assert.throws(() => validateConfig({ projectFile: '' }), /projectFile must be a non-empty string/)
})

test('disable must be an array of server names', () => {
  assert.throws(() => validateConfig({ disable: [1] }), /disable must be an array of server names/)
  assert.throws(() => validateConfig({ disable: 'mysql' }), /disable must be an array of server names/)
})

test('failOnStartupError and watch must be booleans', () => {
  assert.throws(() => validateConfig({ failOnStartupError: 'yes' }), /failOnStartupError must be a boolean/)
  assert.throws(() => validateConfig({ watch: 1 }), /watch must be a boolean/)
  assert.equal(validateConfig({ watch: true }).watch, true)
})

test('toolCallTimeoutMs must be a positive finite number', () => {
  assert.throws(() => validateConfig({ toolCallTimeoutMs: 0 }), /toolCallTimeoutMs must be a positive finite number/)
  assert.throws(() => validateConfig({ toolCallTimeoutMs: Number.NaN }), /toolCallTimeoutMs must be a positive finite number/)
  assert.equal(validateConfig({ toolCallTimeoutMs: 1234 }).toolCallTimeoutMs, 1234)
})

test('the removed gateway block is refused with a pointer, not a generic unknown-key error', () => {
  assert.throws(
    () => validateConfig({ gateway: true }),
    /the "gateway" discovery block was removed in the mcp-only build/,
  )
})
