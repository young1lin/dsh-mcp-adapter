/**
 * The plugin-private native catalog: mysql/rest/echo-style definitions that
 * have NO legal shape in a standard .mcp.json, plus per-entry UI metadata
 * (enabled/group/order). One catalog per scope — global and per-workspace —
 * stored as a sealed envelope in <storage>/catalog/ using the ENGINE's
 * envelope format (secure/statefile), so the same reader that will migrate
 * an old gateway's files in P6 reads these too, and a copied data dir is
 * ciphertext anywhere else.
 *
 * Session overrides (session-store.ts) are deliberately a SEPARATE store:
 * they bind to a live session id and never write back into catalogs.
 *
 * @module dsh-mcp-adapter/config/native-catalog
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { readSecureJson, writeSecureJson } from '../engine/secure/statefile.js'
import type { McpDefinition } from './types.js'

/** Catalog file format version. Bump on breaking shape changes. */
export const CATALOG_SCHEMA_VERSION = 1

/** One native entry: the definition plus UI state. */
export interface NativeEntry {
  def: McpDefinition
  /** UI enabled state; the tombstone equivalent for masking lower layers. */
  enabled: boolean
  group?: string
  /** Catalog-local order hint (group ordering is a UI concern). */
  order?: number
}

/** The whole catalog file. */
export interface NativeCatalog {
  schemaVersion: number
  entries: Record<string, NativeEntry>
}

/** An empty catalog for a missing file (a normal state). */
export function emptyCatalog(): NativeCatalog {
  return { schemaVersion: CATALOG_SCHEMA_VERSION, entries: {} }
}

function coerce(raw: unknown): NativeCatalog | undefined {
  if (raw === undefined) return undefined
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const version = (raw as Record<string, unknown>).schemaVersion
  if (version !== CATALOG_SCHEMA_VERSION) return undefined
  const entriesRaw = (raw as Record<string, unknown>).entries
  if (typeof entriesRaw !== 'object' || entriesRaw === null) return undefined
  const entries: Record<string, NativeEntry> = {}
  for (const [name, value] of Object.entries(entriesRaw as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object') continue
    const entry = value as Record<string, unknown>
    if (entry.def === null || typeof entry.def !== 'object') continue
    entries[name] = {
      def: entry.def as McpDefinition,
      enabled: entry.enabled !== false,
      ...(typeof entry.group === 'string' ? { group: entry.group } : {}),
      ...(typeof entry.order === 'number' ? { order: entry.order } : {}),
    }
  }
  return { schemaVersion: CATALOG_SCHEMA_VERSION, entries }
}

/** Where the global catalog lives. */
export function globalCatalogPath(storageDir: string): string {
  return join(storageDir, 'catalog', 'global.json')
}

/** Where one workspace's catalog lives (keyed by host workspace id). */
export function projectCatalogPath(storageDir: string, workspaceId: string): string {
  return join(storageDir, 'catalog', 'projects', workspaceId + '.json')
}

/**
 * Read one catalog. Missing file -> empty; undecryptable/unparsable -> the
 * problem rides out (a clear read-only signal, never data destruction).
 */
export async function readCatalog(path: string): Promise<{ catalog: NativeCatalog; problem?: string }> {
  try {
    const raw = readSecureJson(path)
    if (raw === undefined) return { catalog: emptyCatalog() }
    const coerced = coerce(raw)
    if (coerced === undefined) {
      return { catalog: emptyCatalog(), problem: path + ' is not a v' + String(CATALOG_SCHEMA_VERSION) + ' catalog' }
    }
    return { catalog: coerced }
  } catch (error) {
    return {
      catalog: emptyCatalog(),
      problem: path + ' cannot be decrypted with this machine key: ' + String((error as Error).message),
    }
  }
}

/**
 * Persist one catalog (whole-file, sealed, atomic via writeSecureJson).
 * Unknown fields inside entries survive verbatim; the file shape stays v1.
 */
export async function writeCatalog(path: string, catalog: NativeCatalog): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  writeSecureJson(path, { schemaVersion: CATALOG_SCHEMA_VERSION, entries: catalog.entries })
}

/**
 * Point-edit one native entry under a revision contract like the standard
 * repo's: the caller passes the revision it read (the catalog's content
 * hash), a mismatch refuses. def === null deletes the entry.
 */
export async function upsertCatalogEntry(
  path: string,
  name: string,
  entry: NativeEntry | null,
  expectedRevision: string,
): Promise<{ revision: string }> {
  const { catalog, problem } = await readCatalog(path)
  if (problem !== undefined) return Promise.reject({ code: 'INVALID', message: problem })
  if (revisionOfCatalog(catalog) !== expectedRevision) {
    return Promise.reject({
      code: 'CONFLICT',
      message: path + ' changed since it was read; re-read and merge',
      currentRevision: revisionOfCatalog(catalog),
    })
  }
  if (entry === null) delete catalog.entries[name]
  else catalog.entries[name] = entry
  await writeCatalog(path, catalog)
  return { revision: revisionOfCatalog(catalog) }
}

import { createHash } from 'node:crypto'

/** Content hash of a catalog (in-memory shape, stable key order via JSON). */
export function revisionOfCatalog(catalog: NativeCatalog): string {
  const text = JSON.stringify({ schemaVersion: catalog.schemaVersion, entries: Object.keys(catalog.entries).sort().map((k) => [k, catalog.entries[k]]) })
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
}
