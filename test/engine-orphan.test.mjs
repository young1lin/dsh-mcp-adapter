/**
 * Orphan-reap semantics over REAL processes: a ledger entry whose owner is
 * dead and whose command line carries our entry marker is killed; a live
 * owner's child is left alone; a dead pid's ledger is just dropped.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reapOrphanedEngines } from '../dist/runtime/engine-supervisor.js'

/** A dead pid: 0x7fffffff-2 is never allocated on Windows. */
const DEAD_OWNER = 2147483646

function pidAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

function fixture() {
  // The marker rides the command line; reapOrphanedEngines matches on it.
  return spawn(process.execPath, ['-e', '/* mcp-manager-orphan-fixture */ setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
}

function writeLedger(dir, pid, owner, entry) {
  mkdirSync(join(dir, 'runtime'), { recursive: true })
  const name = 'engine-' + pid + '.json'
  writeFileSync(join(dir, 'runtime', name), JSON.stringify({ pid, owner, entry, startedAt: new Date().toISOString() }))
}

test('reap: kills a dead-owner orphan whose cmdline matches, skips live-owner and stale entries', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-manager-reap-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const orphan = fixture()
  const owned = fixture()
  await Promise.all([onceSpawned(orphan), onceSpawned(owned)])
  assert.equal(pidAlive(orphan.pid), true)
  assert.equal(pidAlive(owned.pid), true)

  writeLedger(dir, orphan.pid, DEAD_OWNER, 'mcp-manager-orphan-fixture')
  writeLedger(dir, owned.pid, process.pid, 'mcp-manager-orphan-fixture') // owner alive: skip
  writeLedger(dir, DEAD_OWNER, DEAD_OWNER, 'mcp-manager-orphan-fixture') // pid not alive: ledger dropped

  const warnings = []
  const handled = reapOrphanedEngines(dir, process.pid, (l) => warnings.push(l))

  assert.deepEqual(handled, [orphan.pid], 'only the dead-owner orphan was killed')
  await new Promise((resolve) => orphan.once('exit', resolve))
  assert.equal(pidAlive(owned.pid), true, 'live-owner child untouched')
  owned.kill()
  await new Promise((resolve) => owned.once('exit', resolve))
  assert.ok(warnings.some((w) => w.includes('reaping orphaned engine')))
})

function onceSpawned(child) {
  return new Promise((resolve) => { if (child.pid !== undefined) resolve(); else child.once('spawn', resolve) })
}
