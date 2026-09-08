/**
 * Per-session override store (TASK 3.1/4.1): session-level entries bound to
 * a REAL dsh session id, persisted as one sealed file per session under
 * <storage>/sessions/<sessionId>.json. Session overrides never write back to
 * global/project sources; a change to an EXISTING session is stored as
 * pending until a later session adopts it (the snapshot itself is P3).
 *
 * A session file holds full-entry replacements and explicit disables:
 *   { schemaVersion: 1, overrides: { <name>: { def } | { disabled: true } } }
 *
 * Snapshot v2 (docs/progress-review.md R3): the registration snapshot now
 * freezes the WHOLE restorable generation — per server the logical name, the
 * engine instance name it was ensured under, the effective (native-dialect)
 * definition with REAL secrets, and the tool schemas — all sealed at rest by
 * writeSecureJson (machine-bound). A v2 snapshot is IMMUTABLE: the first
 * registration writes it and nothing rewrites it afterwards, so a restored
 * session replays exactly the generation it was born with instead of the
 * current preview. Legacy v1 snapshots (tool-name lists) remain readable but
 * are not restorable; their sessions recompute once and upgrade to v2.
 *
 * @module dsh-mcp-adapter/config/session-store
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { readSecureJson, writeSecureJson } from '../engine/secure/statefile.js'
import type { McpDefinition } from './types.js'

/** Session file format version. */
export const SESSION_SCHEMA_VERSION = 1

/** One override: a whole-entry replacement, or an explicit disable. */
export interface SessionOverride {
  def?: McpDefinition
  disabled?: boolean
}

/** One tool descriptor frozen into a snapshot: schema only, no live handle. */
export interface SnapshotTool {
  name: string
  description?: string
  inputSchema?: unknown
}

/**
 * One server frozen into a v2 snapshot: the LOGICAL name (user-facing
 * namespace, stable across generations), the ENGINE INSTANCE name the
 * definition was ensured under (unique per workspace/def, R2), the effective
 * native-dialect def (real secrets; the file is sealed), and the tool
 * schemas captured at registration.
 */
export interface SessionSnapshotServer {
  logical: string
  instance: string
  def: McpDefinition
  tools: SnapshotTool[]
}

/** v2 registration snapshot (R3): the immutable, restorable generation. */
export interface SessionSnapshot {
  version: 2
  workspaceId: string
  registeredAt: string
  /** Fingerprint of the preview the generation was computed from. */
  configRevision: string
  servers: SessionSnapshotServer[]
}

/** v1 snapshot (pre-R3): tool names only — readable, never restorable. */
export interface LegacySessionSnapshot {
  revision: string
  registeredAt: string
  tools: string[]
}

/** The whole session file. */
export interface SessionFile {
  schemaVersion: number
  overrides: Record<string, SessionOverride>
  /**
   * Registration snapshot (P3.4/R3): written once at the first tool
   * registration, read-only everywhere else. v1 shapes stay loadable so old
   * files never block a session; isRestorableSnapshot tells them apart.
   */
  snapshot?: SessionSnapshot | LegacySessionSnapshot
}

export function emptySessionFile(): SessionFile {
  return { schemaVersion: SESSION_SCHEMA_VERSION, overrides: {} }
}

/** Where one session's overrides live. */
export function sessionFilePath(storageDir: string, sessionId: string): string {
  // Session ids are host-minted opaque tokens; keep them off the filesystem
  // specials (., ..) and bound to one path segment.
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, '_')
  return join(storageDir, 'sessions', safe + '.json')
}

/** Type guard: a v2 snapshot that can actually restore a generation. */
export function isRestorableSnapshot(snapshot: SessionSnapshot | LegacySessionSnapshot | undefined): snapshot is SessionSnapshot {
  return snapshot !== undefined && (snapshot as SessionSnapshot).version === 2 && Array.isArray((snapshot as SessionSnapshot).servers)
}

function coerceTool(raw: unknown): SnapshotTool | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const name = (raw as Record<string, unknown>).name
  if (typeof name !== 'string' || name.length === 0) return undefined
  const out: SnapshotTool = { name }
  const description = (raw as Record<string, unknown>).description
  if (typeof description === 'string') out.description = description
  if ('inputSchema' in (raw as Record<string, unknown>)) out.inputSchema = (raw as Record<string, unknown>).inputSchema
  return out
}

function coerceSnapshot(raw: unknown): SessionSnapshot | LegacySessionSnapshot | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  if (record.version === 2 && Array.isArray(record.servers)) {
    const servers: SessionSnapshotServer[] = []
    for (const serverRaw of record.servers) {
      if (serverRaw === null || typeof serverRaw !== 'object') continue
      const server = serverRaw as Record<string, unknown>
      const logical = server.logical
      const instance = server.instance
      const def = server.def
      if (typeof logical !== 'string' || typeof instance !== 'string' || def === null || typeof def !== 'object') continue
      const tools = Array.isArray(server.tools)
        ? server.tools.map(coerceTool).filter((t): t is SnapshotTool => t !== undefined)
        : []
      servers.push({ logical, instance, def: def as McpDefinition, tools })
    }
    return {
      version: 2,
      workspaceId: String(record.workspaceId ?? ''),
      registeredAt: String(record.registeredAt ?? ''),
      configRevision: String(record.configRevision ?? ''),
      servers,
    }
  }
  if (Array.isArray(record.tools)) {
    return {
      revision: String(record.revision ?? ''),
      registeredAt: String(record.registeredAt ?? ''),
      tools: record.tools.filter((t): t is string => typeof t === 'string'),
    }
  }
  return undefined
}

function coerce(raw: unknown): SessionFile | undefined {
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const version = (raw as Record<string, unknown>).schemaVersion
  if (version !== SESSION_SCHEMA_VERSION) return undefined
  const overridesRaw = (raw as Record<string, unknown>).overrides
  if (typeof overridesRaw !== 'object' || overridesRaw === null) return undefined
  const overrides: Record<string, SessionOverride> = {}
  for (const [name, value] of Object.entries(overridesRaw as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object') continue
    const entry = value as Record<string, unknown>
    if (entry.def !== null && typeof entry.def === 'object') overrides[name] = { def: entry.def as McpDefinition }
    else if (entry.disabled === true) overrides[name] = { disabled: true }
  }
  const snapshot = coerceSnapshot((raw as Record<string, unknown>).snapshot)
  return { schemaVersion: SESSION_SCHEMA_VERSION, overrides, ...(snapshot !== undefined ? { snapshot } : {}) }
}

/** Read one session's overrides (missing file = empty; problems ride out). */
export async function readSessionFile(path: string): Promise<{ file: SessionFile; problem?: string }> {
  try {
    const raw = readSecureJson(path)
    if (raw === undefined) return { file: emptySessionFile() }
    const coerced = coerce(raw)
    if (coerced === undefined) {
      return { file: emptySessionFile(), problem: path + ' is not a v' + String(SESSION_SCHEMA_VERSION) + ' session file — overrides unavailable (read-only)' }
    }
    return { file: coerced }
  } catch (error) {
    return {
      file: emptySessionFile(),
      problem: path + ' cannot be decrypted with this machine key: ' + String((error as Error).message),
    }
  }
}

/** Persist a whole session file (sealed + atomic). Caller owns shape. */
export async function writeSessionFile(path: string, file: SessionFile): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  writeSecureJson(path, file)
}

/**
 * Content hash of a session file's OVERRIDES only. Snapshot writes never
 * bump this revision on purpose: the snapshot is written by the runtime at
 * registration time and must not invalidate an editor holding
 * expectedRevision over the same file's overrides.
 */
export function revisionOfSession(file: SessionFile): string {
  const text = JSON.stringify({ schemaVersion: file.schemaVersion, overrides: Object.keys(file.overrides).sort().map((k) => [k, file.overrides[k]]) })
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
}

/**
 * Per-path write serialization: every read-modify-write on one session file
 * (override upserts, snapshot writes) chains on the previous one so two
 * writers cannot lose each other's half of the file.
 */
const pathTails = new Map<string, Promise<unknown>>()

function withPathLock<T>(path: string, run: () => Promise<T>): Promise<T> {
  const tail = pathTails.get(path) ?? Promise.resolve()
  const next = tail.then(run, run)
  pathTails.set(path, next.then(() => undefined, () => undefined))
  return next
}

/**
 * Write the registration snapshot ONCE (R3 immutability): when a restorable
 * v2 snapshot already exists it is returned untouched and nothing is written —
 * a re-installed (restored/forked/restarted) session keeps the generation it
 * was born with. A LEGACY v1 snapshot (tool names only, never restorable) is
 * upgraded in place by the recomputing install. The overrides ride along
 * unchanged either way.
 */
export async function writeSnapshotImmutable(
  path: string,
  snapshot: SessionSnapshot,
): Promise<{ wrote: boolean; current: SessionSnapshot | LegacySessionSnapshot | undefined }> {
  return await withPathLock(path, async () => {
    const { file, problem } = await readSessionFile(path)
    if (problem !== undefined) {
      // Undecryptable/corrupt file: writing would destroy data. Refuse.
      return { wrote: false, current: undefined }
    }
    if (isRestorableSnapshot(file.snapshot)) return { wrote: false, current: file.snapshot }
    await writeSessionFile(path, { schemaVersion: file.schemaVersion, overrides: file.overrides, snapshot })
    return { wrote: true, current: snapshot }
  })
}

/**
 * Point-edit one session override under the revision contract. entry === null
 * DELETES the override (= re-inherit, TASK 3.3).
 */
export async function upsertSessionOverride(
  path: string,
  name: string,
  entry: SessionOverride | null,
  expectedRevision: string,
): Promise<{ revision: string }> {
  return await withPathLock(path, async () => {
    const { file, problem } = await readSessionFile(path)
    if (problem !== undefined) return Promise.reject({ code: 'INVALID', message: problem })
    if (revisionOfSession(file) !== expectedRevision) {
      return Promise.reject({
        code: 'CONFLICT',
        message: path + ' changed since it was read; re-read and merge',
        currentRevision: revisionOfSession(file),
      })
    }
    if (entry === null) delete file.overrides[name]
    else file.overrides[name] = entry
    await mkdir(join(path, '..'), { recursive: true })
    writeSecureJson(path, file)
    return { revision: revisionOfSession(file) }
  })
}
