/** sealed store: round-trip, entry validation, version guard. */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seal, open, readStore, writeStore, openSecret, putSecret, sealedStorePath } from '../dist/sealed.js'

let dir
let store

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-mcp-sealed-'))
  store = join(dir, 'sealed.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

test('sealedStorePath honors DSH_HOME', () => {
  process.env.DSH_HOME = dir
  try {
    assert.equal(sealedStorePath(), join(dir, 'mcp-json-adapter', 'sealed.json'))
  } finally {
    delete process.env.DSH_HOME
  }
})

test('seal/open round-trips on this platform (DPAPI or machine key)', () => {
  const entry = seal('plain-secret-值')
  assert.ok(entry.alg === 'dpapi' || entry.alg === 'machine')
  const entryNoMeta = { ...entry }
  delete entryNoMeta.createdAt
  assert.equal(open(entryNoMeta), 'plain-secret-值')
  assert.notEqual(entry.blob, 'plain-secret-值', 'the blob is not the plaintext')
})

test('open rejects malformed entries and unknown algorithms', () => {
  assert.throws(() => open(null), /malformed entry/)
  assert.throws(() => open({ alg: 'nope', iv: '', blob: '' }), /unknown alg nope/)
})

test('readStore rejects wrong versions and writeStore round-trips', () => {
  writeFileSync(store, JSON.stringify({ version: 99, entries: {} }))
  assert.throws(() => readStore(store), /is not a version-1 sealed store/)
  writeStore({ a: seal('x') }, store)
  const entries = readStore(store)
  assert.ok(entries.a)
  assert.equal(typeof entries.a.blob, 'string')
})

test('putSecret/openSecret round-trip with createdAt bookkeeping', () => {
  putSecret('gateway-token', 'tok-1', store)
  const entries = readStore(store)
  assert.ok(entries['gateway-token'].createdAt, 'createdAt is stamped')
  assert.equal(openSecret('gateway-token', store), 'tok-1')
  putSecret('gateway-token', 'tok-2', store)
  assert.equal(openSecret('gateway-token', store), 'tok-2')
  assert.equal(openSecret('missing', store), undefined)
})

test('openSecret swallows a corrupt store instead of throwing', () => {
  writeFileSync(store, '{ broken')
  assert.equal(openSecret('gateway-token', store), undefined)
  // A corrupt store is replaced on the next putSecret.
  putSecret('gateway-token', 'tok-3', store)
  assert.equal(openSecret('gateway-token', store), 'tok-3')
})
