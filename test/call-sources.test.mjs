/**
 * Which call logs belong to one entry.
 *
 * A DSH agent does not call an entry by its logical name: the session plane
 * ensures it on the engine under a minted instance name, and the call log
 * follows the instance. So the panel's Calls tab read an empty log for an
 * entry the workspace's agents had been calling all day, and nothing in the UI
 * admitted the other log existed. These tests pin the two halves of the fix:
 * the naming rule runs in reverse, and the engine can list the logs it finds.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { listCallSources, setCallLogDir } from '../dist/engine/calls.js'
import { instanceNameFor } from '../dist/runtime/session-runtime.js'
import { instanceTail, isSessionInstanceOf, logicalKeyOf, parseSessionInstance } from '../dist/shared/instance-name.js'

const DEF = { type: 'http', url: 'https://example.invalid/mcp' }

function line(seq, at, tool = 'web_search_prime', via = 'dsh-session') {
  return JSON.stringify({ seq, at, tool, via, ok: true, ms: 12, args: '{}', output: 'x' }) + '\n'
}

test('the mint and the matcher are the same rule', () => {
  const minted = instanceNameFor('wSomeWorkspace', 'web-search', DEF)
  assert.match(minted, /^s[0-9a-f]{10}-[0-9a-f]{10}-web-search$/, 'shape: two hashes and a readable tail')
  assert.equal(isSessionInstanceOf(minted, 'web-search'), true)
  // A different entry must not claim it, however similar the name.
  assert.equal(isSessionInstanceOf(minted, 'web'), false)
  assert.equal(isSessionInstanceOf(minted, 'web-search-2'), false)
  // Nor may an ordinary entry name be mistaken for a session instance.
  assert.equal(isSessionInstanceOf('web-search', 'web-search'), false)
  assert.equal(parseSessionInstance('web-search'), undefined)
  // Two sessions in different workspaces are two instances, both this entry's.
  const other = instanceNameFor('wOther', 'web-search', DEF)
  assert.notEqual(other, minted)
  assert.equal(isSessionInstanceOf(other, 'web-search'), true)
  // A name the engine could not accept is never minted.
  const odd = instanceNameFor('w1', 'a name/with spaces', DEF)
  assert.match(odd, /^[A-Za-z0-9_-]{1,63}$/)
  assert.equal(instanceTail('a name/with spaces'), 'a_name_with_spaces')
})

test('listCallSources finds the session logs an entry accumulated', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mmc-calls-'))
  try {
    setCallLogDir(dir)
    const session = instanceNameFor('wA', 'alpha', DEF)
    const otherEntry = instanceNameFor('wA', 'beta', DEF)
    writeFileSync(join(dir, 'alpha.jsonl'), line(1, '2026-09-07T01:00:00.000Z', 'echo', 'panel'))
    writeFileSync(join(dir, session + '.jsonl'), line(1, '2026-09-07T02:00:00.000Z') + line(2, '2026-09-07T03:00:00.000Z'))
    writeFileSync(join(dir, otherEntry + '.jsonl'), line(1, '2026-09-07T04:00:00.000Z'))
    writeFileSync(join(dir, 'beta.jsonl'), line(1, '2026-09-07T05:00:00.000Z'))

    const sources = await listCallSources('alpha')
    assert.deepEqual(sources.map((x) => x.name), ['alpha', session],
      'this entry only: another entry\'s session log is not ours')
    assert.equal(sources[0].session, false, 'the entry\'s own log leads')
    assert.equal(sources[1].session, true)
    assert.equal(sources[1].lastSeq, 2, 'the newest call in that log')
    assert.equal(sources[1].lastAt, '2026-09-07T03:00:00.000Z')

    // Each log keeps its own numbering, which is why they are not merged: both
    // of these files have a call numbered 1, and `seq` is how one is opened.
    assert.equal(sources[0].lastSeq, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an entry with nothing logged yet still offers its own log', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mmc-calls-'))
  try {
    setCallLogDir(dir)
    const sources = await listCallSources('never-called')
    assert.deepEqual(sources, [{ name: 'never-called', session: false }],
      'the source the panel opens on is not a row that comes and goes')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a per-entry setting is keyed by the ENTRY, not by the instance it was made on', async () => {
  // Two generations of one entry: the def changed, so the minted name did too.
  const first = instanceNameFor('ws-a', 'vision-api', { type: 'proc', command: 'a' })
  const second = instanceNameFor('ws-a', 'vision-api', { type: 'proc', command: 'b' })
  assert.notEqual(first, second, 'an edit mints a new instance — that is the point of the def hash')
  assert.equal(logicalKeyOf(first), 'vision-api')
  assert.equal(logicalKeyOf(second), 'vision-api', 'and the toggle made on the old one still applies')

  // Another workspace, same entry: one setting, not one per project.
  assert.equal(logicalKeyOf(instanceNameFor('ws-b', 'vision-api', { type: 'proc', command: 'a' })), 'vision-api')

  // A catalog name is already the key; it must not be mangled into a different one.
  assert.equal(logicalKeyOf('vision-api'), 'vision-api')
  assert.equal(logicalKeyOf('db_1-x'), 'db_1-x')
})
