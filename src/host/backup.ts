/**
 * Backup export / restore over the REAL layer files (the Advanced page's
 * Backup card, P5.6). Export reads every persistence layer the config
 * service knows — the global standard file, global + per-workspace native
 * catalogs, project standard files, session override files — with REAL
 * values (a backup that cannot restore secrets is not a backup). Restore
 * is explicit, mode-separated (merge keeps entries the backup does not
 * mention; replace deletes them), and refuses unknown workspaces rather
 * than inventing paths.
 *
 * @module dsh-mcp-adapter/host/backup
 */

import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readStandardFile, writeStandardFile } from '../config/standard-repo.js'
import {
  globalCatalogPath, projectCatalogPath, readCatalog, writeCatalog, type NativeCatalog,
} from '../config/native-catalog.js'
import { readSessionFile, sessionFilePath } from '../config/session-store.js'
import { expandHome } from '../shared.js'

/** The backup document the browser downloads (and pastes back for restore). */
export interface BackupDocument {
  version: number
  generatedAt: string
  payload: Record<string, unknown>
}

/** What restore reports per layer: entries written, plus every skipped layer. */
export interface RestoreResult {
  restored: Record<string, number>
  skipped: Array<{ layerId: string; reason: string }>
}

interface WorkspaceRef { id: string; root: string }

function defaultGlobalFile(): string {
  return expandHome(join(homedir(), '.agents', '.mcp.json'))
}

/** Read one standard file's raw document, or undefined when absent/broken. */
async function standardDoc(path: string): Promise<Record<string, unknown> | undefined> {
  const doc = await readStandardFile(path)
  if (!doc.exists || doc.problem !== undefined) return undefined
  return doc.doc
}

/**
 * Export every layer. Sessions ride along (their overrides are real config
 * a future restore may want to inspect), but see restoreBackup for why they
 * are not written back.
 */
export async function exportBackup(input: {
  storageDir: string
  globalFile?: string
  workspaces: WorkspaceRef[]
}): Promise<BackupDocument> {
  const globalFile = input.globalFile !== undefined ? input.globalFile : defaultGlobalFile()
  const payload: Record<string, unknown> = {}

  const gDoc = await standardDoc(globalFile)
  const gCat = await readCatalog(globalCatalogPath(input.storageDir))
  payload.global = {
    ...(gDoc !== undefined ? { standard: gDoc } : {}),
    native: gCat.catalog.entries,
  }

  const projects: Record<string, unknown> = {}
  for (const ws of input.workspaces) {
    const root = await standardDoc(join(ws.root, '.mcp.json'))
    const agents = await standardDoc(join(ws.root, '.agents', '.mcp.json'))
    const cat = await readCatalog(projectCatalogPath(input.storageDir, ws.id))
    projects[ws.id] = {
      ...(root !== undefined ? { root } : {}),
      ...(agents !== undefined ? { agents } : {}),
      native: cat.catalog.entries,
    }
  }
  payload.projects = projects

  const sessions: Record<string, unknown> = {}
  try {
    const files = await readdir(join(input.storageDir, 'sessions'))
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      const id = f.slice(0, -'.json'.length)
      const { file } = await readSessionFile(sessionFilePath(input.storageDir, id))
      sessions[id] = { overrides: file.overrides, ...(file.snapshot !== undefined ? { snapshot: file.snapshot } : {}) }
    }
  } catch { /* no sessions directory: nothing to copy */ }
  payload.sessions = sessions

  return { version: 1, generatedAt: new Date().toISOString(), payload }
}

/** Restore one standard layer under the mode. */
async function restoreStandard(path: string, layerId: string, raw: unknown, mode: 'merge' | 'replace', out: RestoreResult): Promise<void> {
  if (raw === undefined) return
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    out.skipped.push({ layerId, reason: 'not a standard document' })
    return
  }
  const servers = (raw as Record<string, unknown>).mcpServers
  if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) {
    out.skipped.push({ layerId, reason: 'missing mcpServers object' })
    return
  }
  const current = await readStandardFile(path)
  if (current.problem !== undefined && current.problem.code !== 'UNREADABLE') {
    out.skipped.push({ layerId, reason: current.problem.message })
    return
  }
  const merged: Record<string, unknown> = mode === 'replace' ? {} : { ...((current.doc.mcpServers as Record<string, unknown> | undefined) ?? {}) }
  for (const [name, def] of Object.entries(servers as Record<string, unknown>)) merged[name] = def
  await writeStandardFile(path, { ...(mode === 'merge' ? current.doc : {}), mcpServers: merged }, current.revision)
  out.restored[layerId] = Object.keys(servers as Record<string, unknown>).length
}

/** Restore one native catalog under the mode. */
async function restoreNative(path: string, layerId: string, raw: unknown, mode: 'merge' | 'replace', out: RestoreResult): Promise<void> {
  if (raw === undefined) return
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    out.skipped.push({ layerId, reason: 'not a native catalog' })
    return
  }
  const { catalog, problem } = await readCatalog(path)
  if (problem !== undefined) {
    out.skipped.push({ layerId, reason: problem })
    return
  }
  const entries: NativeCatalog['entries'] = mode === 'replace' ? {} : { ...catalog.entries }
  let n = 0
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object') continue
    const entry = value as { def?: unknown; enabled?: unknown; group?: unknown; order?: unknown }
    if (entry.def === null || typeof entry.def !== 'object') continue
    entries[name] = {
      def: entry.def as never,
      enabled: entry.enabled !== false,
      ...(typeof entry.group === 'string' ? { group: entry.group } : {}),
      ...(typeof entry.order === 'number' ? { order: entry.order } : {}),
    }
    n++
  }
  await writeCatalog(path, { schemaVersion: 1, entries })
  out.restored[layerId] = n
}

/**
 * Apply a backup document (the whole document, or just its payload object).
 * Unknown workspace ids in the backup are skipped with a reason — restore
 * never invents filesystem paths from untrusted input. Session layers are
 * never written back: they bind to live session ids and restoring them
 * could clobber an active session's registration snapshot.
 */
export async function restoreBackup(
  input: { storageDir: string; globalFile?: string; workspaces: WorkspaceRef[] },
  raw: unknown,
  mode: 'merge' | 'replace',
): Promise<RestoreResult> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw Object.assign(new Error('backup payload must be an object'), { code: 'INVALID' })
  }
  const asDoc = raw as { payload?: unknown }
  const payload = (asDoc.payload !== null && typeof asDoc.payload === 'object' && !Array.isArray(asDoc.payload) ? asDoc.payload : raw) as Record<string, unknown>
  const globalFile = input.globalFile !== undefined ? input.globalFile : defaultGlobalFile()
  const out: RestoreResult = { restored: {}, skipped: [] }

  const g = (payload.global ?? {}) as Record<string, unknown>
  await restoreStandard(globalFile, 'global:standard', g.standard, mode, out)
  await restoreNative(globalCatalogPath(input.storageDir), 'global:native', g.native, mode, out)

  const projects = (payload.projects ?? {}) as Record<string, unknown>
  for (const [wsId, value] of Object.entries(projects)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      out.skipped.push({ layerId: 'project:' + wsId, reason: 'not a project section' })
      continue
    }
    const ws = input.workspaces.find((w) => w.id === wsId)
    if (ws === undefined) {
      out.skipped.push({ layerId: 'project:' + wsId, reason: 'unknown workspace on this machine' })
      continue
    }
    const section = value as Record<string, unknown>
    await restoreStandard(join(ws.root, '.mcp.json'), 'project:root', section.root, mode, out)
    await restoreStandard(join(ws.root, '.agents', '.mcp.json'), 'project:agents', section.agents, mode, out)
    await restoreNative(projectCatalogPath(input.storageDir, wsId), 'project:native', section.native, mode, out)
  }

  const sessions = (payload.sessions ?? {}) as Record<string, unknown>
  for (const id of Object.keys(sessions)) {
    out.skipped.push({ layerId: 'session:' + id, reason: 'session layers are never restored (bound to live sessions)' })
  }
  return out
}
