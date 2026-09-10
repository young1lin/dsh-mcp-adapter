/**
 * The configuration service facade (TASK P2.5): the ONE surface the host
 * exposes to the browser (and later to the engine's runtime plane). The
 * browser names a scope by workspaceId/sessionId — never a path; the host
 * resolves every path here, refuses symlink/escaping targets, and masks
 * secrets on the way out. Saves are per-target transactions under the
 * expectedRevision contract; a whole save is ONE commit (one file write per
 * operation, sequenced by the per-path queues), not a per-field reload.
 *
 * @module dsh-mcp-adapter/config/service
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { lstat } from 'node:fs/promises'
import { maskDef, unmaskBody } from '../engine/mask.js'
import { expandHome } from '../shared.js'
import {
  emptyDoc, readStandardFile, upsertStandardEntry, writeStandardFile, validateEntry,
} from './standard-repo.js'
import {
  emptyCatalog, globalCatalogPath, projectCatalogPath, readCatalog, revisionOfCatalog, upsertCatalogEntry, writeCatalog,
} from './native-catalog.js'
import {
  emptySessionFile, readSessionFile, revisionOfSession, sessionFilePath, upsertSessionOverride,
} from './session-store.js'
import { buildPreview, type Mention } from './merge.js'
import type {
  LayerInfo, McpDefinition, MergedEntry, ScopeLevel, ScopePreview, StandardFileProblem,
} from './types.js'
import type { NativeEntry } from './native-catalog.js'

/** Resolves a host workspace id to its root directory (P5 wires DSH's real one). */
export interface WorkspaceResolver {
  resolve(workspaceId?: string): { root: string } | undefined
}

/** Service construction options. */
export interface ConfigServiceOptions {
  /** Plugin-private storage root (<dsh home>/mcp-manager). */
  storageDir: string
  /** Global standard file (default ~/.agents/.mcp.json). */
  globalFile?: string
  workspaceResolver?: WorkspaceResolver
}

/** Rejection shapes every save can produce (stable codes for the UI). */
export interface SaveRejection {
  code: 'CONFLICT' | 'INVALID' | 'IO' | 'SCOPE' | 'NOT_FOUND'
  message: string
  currentRevision?: string
}

const LEVELS: Record<ScopeLevel, number> = { global: 0, project: 1, session: 2 }

/** The service facade type (host bridge consumes this shape). */
export type ConfigService = ReturnType<typeof createConfigService>

/**
 * Build the service. Stateless between calls except the per-path queues
 * inside the repositories; every preview re-reads the world (files are the
 * source of truth and may change externally at any time).
 */
export function createConfigService(options: ConfigServiceOptions) {
  const globalFile = resolve(expandHome(options.globalFile ?? join(homedir(), '.agents', '.mcp.json')))

  function resolver(): WorkspaceResolver {
    return options.workspaceResolver ?? {
      resolve() { return undefined }, // no host registry means no project access; never interpret an ID as a path
    }
  }

  /** Refuse symlinked standard files (TASK P2.7): the edit must land in the real file. */
  async function standardProblem(path: string, exists: boolean): Promise<StandardFileProblem | undefined> {
    if (!exists) return undefined
    try {
      const stat = await lstat(path)
      if (stat.isSymbolicLink()) {
        return { path, code: 'SYMLINK', message: path + ' is a symbolic link; edit the target file directly' }
      }
    } catch {
      return undefined // vanished between read and lstat — the read already spoke
    }
    return undefined
  }

  /**
   * Resolve the full scope chain for a view: layers lowest-first, mentions
   * for every name, problems, and the preview assembled by the merge.
   */
  async function preview(input: { workspaceId?: string; sessionId?: string; /**
   * Host-internal trusted callers (the agent entry feeding the engine) pass
   * false to receive REAL secrets; the browser path keeps the default true.
   */ maskSecrets?: boolean }): Promise<ScopePreview> {
    if (input.workspaceId !== undefined && resolver().resolve(input.workspaceId) === undefined) {
      throw Object.assign(new Error('unknown workspace'), { code: 'SCOPE' })
    }
    if (input.sessionId !== undefined && !/^[A-Za-z0-9_-]{1,160}$/.test(input.sessionId)) {
      throw Object.assign(new Error('invalid session id'), { code: 'SCOPE' })
    }
    const layers: LayerInfo[] = []
    const mentions: Mention[] = []
    const problems: StandardFileProblem[] = []

    // --- global standard ---
    const g = await readStandardFile(globalFile)
    const gProblem = g.problem ?? await standardProblem(globalFile, g.exists)
    layers.push({ layerId: 'global:standard', level: 'global', source: 'standard', label: globalFile, exists: g.exists, revision: g.revision, ...(gProblem !== undefined ? { problem: gProblem } : {}) })
    if (gProblem !== undefined) problems.push(gProblem)
    if (gProblem === undefined) {
      for (const [name, def] of Object.entries(g.servers)) {
        mentions.push({ layerId: 'global:standard', name, level: 'global', source: 'standard', label: globalFile, def, disabled: def.disabled === true, revision: g.revision })
      }
    }

    // --- global native ---
    const gCatPath = globalCatalogPath(options.storageDir)
    const gCat = await readCatalog(gCatPath)
    layers.push({ layerId: 'global:native', level: 'global', source: 'native', label: 'native:global', exists: Object.keys(gCat.catalog.entries).length > 0, revision: revisionOfCatalog(gCat.catalog) })
    if (gCat.problem !== undefined) problems.push({ path: gCatPath, code: 'UNREADABLE', message: gCat.problem })
    for (const [name, entry] of Object.entries(gCat.catalog.entries)) {
      mentions.push({ layerId: 'global:native', name, level: 'global', source: 'native', label: 'native:global', def: entry.def, disabled: entry.enabled !== true || entry.def.disabled === true, revision: revisionOfCatalog(gCat.catalog) })
    }

    // --- project scope ---
    const ws = input.workspaceId !== undefined ? resolver().resolve(input.workspaceId) : undefined
    if (ws !== undefined) {
      const rootFiles = [join(ws.root, '.mcp.json'), join(ws.root, '.agents', '.mcp.json')]
      let projectRevision = ''
      for (const path of rootFiles) {
        const layerId = path === rootFiles[0] ? 'project:root' : 'project:agents'
        const doc = await readStandardFile(path)
        const problem = doc.problem ?? await standardProblem(path, doc.exists)
        layers.push({ layerId, level: 'project', source: 'standard', label: path, exists: doc.exists, revision: doc.revision, ...(problem !== undefined ? { problem } : {}) })
        if (problem !== undefined) problems.push(problem)
        if (problem === undefined) {
          projectRevision = doc.revision
          for (const [name, def] of Object.entries(doc.servers)) {
            mentions.push({ layerId, name, level: 'project', source: 'standard', label: path, def, disabled: def.disabled === true, revision: doc.revision })
          }
        }
      }
      const pCatPath = projectCatalogPath(options.storageDir, sanitizeId(input.workspaceId))
      const pCat = await readCatalog(pCatPath)
      layers.push({ layerId: 'project:native', level: 'project', source: 'native', label: 'native:' + String(input.workspaceId), exists: Object.keys(pCat.catalog.entries).length > 0, revision: revisionOfCatalog(pCat.catalog) })
      if (pCat.problem !== undefined) problems.push({ path: pCatPath, code: 'UNREADABLE', message: pCat.problem })
      for (const [name, entry] of Object.entries(pCat.catalog.entries)) {
        mentions.push({ layerId: 'project:native', name, level: 'project', source: 'native', label: 'native:' + String(input.workspaceId), def: entry.def, disabled: entry.enabled !== true || entry.def.disabled === true, revision: revisionOfCatalog(pCat.catalog) })
      }
    }

    // --- session scope ---
    const viewLevel: ScopeLevel = input.sessionId !== undefined ? 'session' : ws !== undefined ? 'project' : 'global'
    if (input.sessionId !== undefined) {
      const sPath = sessionFilePath(options.storageDir, input.sessionId)
      const sFile = await readSessionFile(sPath)
      layers.push({ layerId: 'session:overrides', level: 'session', source: 'session', label: 'session:' + input.sessionId, exists: Object.keys(sFile.file.overrides).length > 0, revision: revisionOfSession(sFile.file) })
      if (sFile.problem !== undefined) problems.push({ path: sPath, code: 'UNREADABLE', message: sFile.problem })
      for (const [name, override] of Object.entries(sFile.file.overrides)) {
        if (override.disabled === true) {
          mentions.push({ layerId: 'session:overrides', name, level: 'session', source: 'session', label: 'session:' + input.sessionId, def: { disabled: true }, disabled: true, revision: revisionOfSession(sFile.file) })
        } else if (override.def !== undefined) {
          mentions.push({ layerId: 'session:overrides', name, level: 'session', source: 'session', label: 'session:' + input.sessionId, def: override.def, disabled: override.def.disabled === true, revision: revisionOfSession(sFile.file) })
        }
      }
    }

    const preview = buildPreview(layers, mentions, viewLevel, problems)
    // Secrets never cross the service edge toward the BROWSER; host-internal
    // engine feeds read the real values (they already hold them).
    if (input.maskSecrets !== false) {
      for (const entry of preview.entries) entry.def = maskDef(entry.def as never) as unknown as McpDefinition
    }
    return preview
  }

  /**
   * One save transaction. The client sends a MASKED def back (sentinels for
   * unchanged secrets); the service restores real values from the current
   * stored def before writing, so a sentinel can never become a credential
   * and an unrelated-field edit cannot destroy a secret (TASK 3.4).
   */
  async function saveEntry(input: {
    level: ScopeLevel
    source: 'standard' | 'native' | 'session'
    name: string
    /** null deletes the entry at this level (= re-inherit). */
    def: McpDefinition | null
    expectedRevision: string
    layerId?: string
    workspaceId?: string
    sessionId?: string
  }): Promise<{ revision: string }> {
    const scopeError = checkScope(input)
    if (scopeError !== undefined) return Promise.reject(scopeError)
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.name) || ['__proto__', 'constructor', 'prototype'].includes(input.name)) {
      return Promise.reject({ code: 'INVALID', message: 'invalid MCP name' })
    }
    const expectedLayer = input.source === 'session' ? 'session:overrides' : input.level + ':' + input.source
    if (input.layerId !== undefined && input.layerId !== expectedLayer &&
      !(input.level === 'project' && input.source === 'standard' && ['project:root', 'project:agents'].includes(input.layerId))) {
      return Promise.reject({ code: 'SCOPE', message: 'layer does not belong to requested scope' })
    }

    if (input.source === 'session') {
      const path = sessionFilePath(options.storageDir, String(input.sessionId))
      const current = await readSessionFile(path)
      if (current.problem !== undefined) return Promise.reject({ code: 'INVALID', message: current.problem } satisfies SaveRejection)
      const stored = current.file.overrides[input.name]?.def
      const override = input.def === null
        ? null
        : { def: unmaskBody(input.def as Record<string, unknown>, stored as never) as unknown as McpDefinition }
      return upsertSessionOverride(path, input.name, override, input.expectedRevision)
    }

    if (input.source === 'native') {
      const path = input.level === 'global'
        ? globalCatalogPath(options.storageDir)
        : projectCatalogPath(options.storageDir, sanitizeId(input.workspaceId))
      const current = await readCatalog(path)
      if (current.problem !== undefined) return Promise.reject({ code: 'INVALID', message: current.problem } satisfies SaveRejection)
      const storedEntry = current.catalog.entries[input.name]
      if (input.def === null) {
        if (storedEntry === undefined) return Promise.reject({ code: 'NOT_FOUND', message: 'no native entry ' + input.name } satisfies SaveRejection)
        return upsertCatalogEntry(path, input.name, null, input.expectedRevision)
      }
      const restored = unmaskBody(input.def as Record<string, unknown>, storedEntry?.def as never) as unknown as McpDefinition
      const invalid = validateNativeDef(input.name, restored)
      if (invalid !== undefined) return Promise.reject({ code: 'INVALID', message: invalid } satisfies SaveRejection)
      const entry: NativeEntry = { ...storedEntry, def: restored, enabled: restored.disabled !== true }
      return upsertCatalogEntry(path, input.name, entry, input.expectedRevision)
    }

    // standard source
    const path = standardPathFor(input.level, input.workspaceId, input.layerId)
    if (path === undefined) return Promise.reject({ code: 'SCOPE', message: 'project scope needs a workspaceId' } satisfies SaveRejection)
    const current = await readStandardFile(path)
    const problem = current.problem ?? await standardProblem(path, current.exists)
    if (problem !== undefined) return Promise.reject({ code: 'INVALID', message: problem.message })
    const stored = current.servers[input.name]
    if (input.def === null) {
      if (stored === undefined) return Promise.reject({ code: 'NOT_FOUND', message: 'no entry ' + input.name + ' in ' + path } satisfies SaveRejection)
      return upsertStandardEntry(path, input.name, null, input.expectedRevision)
    }
    const restored = unmaskBody(input.def as Record<string, unknown>, stored as never) as unknown as McpDefinition
    return upsertStandardEntry(path, input.name, restored, input.expectedRevision)
  }

  /**
   * Toggle a name at one level WITHOUT rewriting its definition: standard
   * files carry the explicit "disabled": true tombstone on the entry; native
   * catalogs flip entry.enabled; session writes/removes a {disabled} override.
   * Enabling at a level that has only an inherited mention creates the local
   * tombstone-removal by pointing at the inherited def (whole-entry copy).
   */
  async function setEnabled(input: {
    level: ScopeLevel
    name: string
    enabled: boolean
    expectedRevision: string
    layerId?: string
    workspaceId?: string
    sessionId?: string
  }): Promise<{ revision: string }> {
    const current = await preview({ workspaceId: input.workspaceId, sessionId: input.sessionId, maskSecrets: false })
    const entry = current.entries.find((e) => e.name === input.name)
    if (entry === undefined) return Promise.reject({ code: 'NOT_FOUND', message: 'unknown MCP: ' + input.name } satisfies SaveRejection)
    if (input.level === 'session') {
      if (input.enabled) {
        // enable at session level = remove the session disable (re-inherit)
        return saveEntry({ level: 'session', source: 'session', name: input.name, def: null, expectedRevision: input.expectedRevision, layerId: input.layerId, workspaceId: input.workspaceId, sessionId: input.sessionId })
      }
      return saveEntry({ level: 'session', source: 'session', name: input.name, def: { disabled: true }, expectedRevision: input.expectedRevision, layerId: input.layerId, workspaceId: input.workspaceId, sessionId: input.sessionId })
    }
    const source = entry.source === 'session' ? 'session' : entry.source
    if (entry.level === input.level && entry.source !== 'session') {
      const def = { ...entry.def, disabled: !input.enabled }
      return saveEntry({ level: input.level, source, name: input.name, def: def as McpDefinition, expectedRevision: input.expectedRevision, layerId: input.layerId, workspaceId: input.workspaceId, sessionId: input.sessionId })
    }
    // Enabling/disabling an INHERITED name at a higher level: copy the whole
    // inherited def (masked round-trip restores secrets) and set the mark.
    const def = { ...entry.def, disabled: !input.enabled }
    return saveEntry({ level: input.level, source, name: input.name, def: def as McpDefinition, expectedRevision: input.expectedRevision, layerId: input.layerId, workspaceId: input.workspaceId, sessionId: input.sessionId })
  }

  function checkScope(input: { level: ScopeLevel; source?: string; workspaceId?: string; sessionId?: string }): SaveRejection | undefined {
    if (!['global', 'project', 'session'].includes(input.level)) return { code: 'SCOPE', message: 'invalid scope' }
    if (input.source !== undefined && (!['standard', 'native', 'session'].includes(input.source) || (input.source === 'session') !== (input.level === 'session'))) return { code: 'SCOPE', message: 'invalid source for scope' }
    if (input.workspaceId !== undefined && resolver().resolve(input.workspaceId) === undefined) return { code: 'SCOPE', message: 'unknown workspace' }
    if (input.sessionId !== undefined && !/^[A-Za-z0-9_-]{1,160}$/.test(input.sessionId)) return { code: 'SCOPE', message: 'invalid session id' }
    if (input.level === 'project' && input.workspaceId === undefined) {
      return { code: 'SCOPE', message: 'project scope requires workspaceId' }
    }
    if (input.level === 'session' && input.sessionId === undefined) {
      return { code: 'SCOPE', message: 'session scope requires sessionId' }
    }
    return undefined
  }

  function standardPathFor(level: ScopeLevel, workspaceId?: string, layerId?: string): string | undefined {
    if (level === 'global') return globalFile
    const ws = workspaceId !== undefined ? resolver().resolve(workspaceId) : undefined
    if (ws === undefined) return undefined
    // TASK 3.3: UI 默认新建写根文件；编辑已有项写它实际来源。The saveEntry
    // caller passes the layer's own path context via level+workspace only, so
    // project writes land in the ROOT file by default; editing an entry that
    // lives in .agents/.mcp.json round-trips through its own revision.
    return layerId === 'project:agents' ? join(ws.root, '.agents', '.mcp.json') : join(ws.root, '.mcp.json')
  }

  return { preview, saveEntry, setEnabled }
}

/** Native defs need a type+connection shape (engine ServerDef dialect). */
function validateNativeDef(name: string, def: McpDefinition): string | undefined {
  if (def.disabled === true && def.type === undefined) return undefined
  if (typeof def.type !== 'string' || def.type.length === 0) {
    return 'native entry "' + name + '" needs a "type" (proc|http|echo|adapter)'
  }
  return undefined
}

/** Filesystem-safe id segment. */
function sanitizeId(id: string | undefined): string {
  const value = String(id ?? '')
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(value)) throw Object.assign(new Error('invalid workspace id'), { code: 'SCOPE' })
  return value
}
