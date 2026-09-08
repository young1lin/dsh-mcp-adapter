/**
 * Migration planner + applier (TASK P6.1/P6.4/P6.5): maps an old gateway
 * data dir onto the unified model — servers into the NATIVE catalog (the
 * one editable source of truth), env/tokens into the ENGINE's own stores by
 * re-sealing into the plugin engine home (same envelope format), with an
 * explicit preview the user confirms before anything lands.
 *
 * Idempotent: a name already present in the target is reported as kept
 * (not overwritten); applying twice converges. Failures leave prior writes
 * intact — each file lands atomically and the report says what did.
 *
 * @module dsh-mcp-adapter/config/legacy-import
 */

import { mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { readLegacyGateway, type LegacyGatewayData } from './legacy-read.js'
import { emptyCatalog, readCatalog, writeCatalog, globalCatalogPath } from './native-catalog.js'
import type { NativeEntry } from './native-catalog.js'

/** One planned migration row. */
export interface MigrationRow {
  kind: 'mcp' | 'tunnel' | 'env' | 'token'
  name: string
  /** native def (mcp rows) or opaque summary (others). */
  summary: string
  action: 'import' | 'keep' | 'skip'
  reason?: string
}

/** The full plan: rows + warnings + file states. */
export interface MigrationPlan {
  source: string
  rows: MigrationRow[]
  warnings: string[]
  undecryptable: string[]
  legacyPlain: string[]
}

/**
 * Plan a migration (dry-run): nothing is written.
 * @param legacyRoot - old gateway data dir.
 * @param storageDir - plugin storage root (target catalogs).
 */
export async function planMigration(legacyRoot: string, storageDir: string): Promise<MigrationPlan> {
  const data = readLegacyGateway(legacyRoot)
  const rows: MigrationRow[] = []
  const warnings: string[] = []
  const undecryptable: string[] = []
  const legacyPlain: string[] = []

  for (const file of [data.gatewayConfig, data.managed, data.tunnels, data.env] as Array<{ path: string; state: string }>) {
    if (file.state === 'undecryptable') undecryptable.push(file.path)
    if (file.state === 'legacyPlain') legacyPlain.push(file.path)
    if (file.state === 'notJson') warnings.push(file.path + ' is not valid JSON — skipped')
  }

  // The existing-catalog check must be settled BEFORE rows are built.
  const existing = new Set<string>(Object.keys((await existingCatalog(storageDir)).entries))

  // MCP rows: gateway.config servers + managed entries (overrides folded).
  if (data.gatewayConfig.data?.servers !== undefined) {
    for (const [name, def] of Object.entries(data.gatewayConfig.data.servers)) {
      rows.push({ kind: 'mcp', name, summary: defSummary(def), action: existing.has(name) ? 'keep' : 'import' })
    }
  }
  if (data.managed.data?.mcps !== undefined) {
    for (const entry of data.managed.data.mcps) {
      if (entry.override === true) {
        const row = rows.find((r) => r.kind === 'mcp' && r.name === entry.name)
        if (row !== undefined) row.summary = defSummary(entry.def) + ' (override wins)'
        continue
      }
      if (rows.some((r) => r.kind === 'mcp' && r.name === entry.name)) continue
      rows.push({
        kind: 'mcp', name: entry.name, summary: defSummary(entry.def),
        action: existing.has(entry.name) ? 'keep' : 'import',
        ...(entry.enabled === false ? { reason: 'was disabled — imported enabled=false' } : {}),
      })
    }
  }
  for (const rule of data.tunnels.data?.rules ?? []) {
    rows.push({ kind: 'tunnel', name: String(rule.name ?? ''), summary: String(rule.localPort) + ' → ' + String(rule.targetHost) + ':' + String(rule.targetPort), action: 'import' })
  }
  for (const [key, value] of Object.entries(data.env.data ?? {})) {
    rows.push({ kind: 'env', name: key, summary: value.length > 0 ? '•••' : '(empty)', action: 'import' })
  }
  for (const token of data.managed.data?.tokens ?? []) {
    rows.push({ kind: 'token', name: token.label, summary: 'id ' + token.id, action: 'import' })
  }

  return { source: legacyRoot, rows, warnings, undecryptable, legacyPlain }
}

async function existingCatalog(storageDir: string) {
  const { catalog } = await readCatalog(globalCatalogPath(storageDir))
  return catalog
}

function defSummary(def: Record<string, unknown>): string {
  if (typeof def.type === 'string') return String(def.type)
  if (typeof def.command === 'string') return 'proc: ' + def.command.slice(0, 40)
  if (typeof def.url === 'string') return 'http: ' + def.url.slice(0, 40)
  return 'unknown shape'
}

/**
 * Apply a planned migration (the user confirmed the preview).
 * - MCP rows import into the GLOBAL native catalog (enabled preserved).
 * - tunnels.json / env.json / managed.json are re-sealed COPIES into the
 *   engine home (same envelope format; the engine then serves tunnels/env/
 *   tokens exactly as before, under the plugin's key).
 * @param plan - a plan from planMigration.
 * @param storageDir - plugin storage root.
 * @returns what landed.
 */
export async function applyMigration(plan: MigrationPlan, storageDir: string): Promise<{ mcps: string[]; files: string[]; skipped: string[] }> {
  const data: LegacyGatewayData = readLegacyGateway(plan.source)
  const mcps: string[] = []
  const skipped: string[] = []

  // 1) MCP rows -> native catalog (one file write)
  const catalogPath = globalCatalogPath(storageDir)
  const { catalog, problem } = await readCatalog(catalogPath)
  if (problem !== undefined) throw new Error('target catalog unreadable: ' + problem)
  for (const row of plan.rows) {
    if (row.kind !== 'mcp' || row.action !== 'import') continue
    const def = defFor(row.name, data)
    if (def === undefined) { skipped.push(row.name); continue }
    const wasEnabled = enabledFor(row.name, data)
    const entry: NativeEntry = { def: def as never, enabled: wasEnabled }
    catalog.entries[row.name] = entry
    mcps.push(row.name)
  }
  if (mcps.length > 0) await writeCatalog(catalogPath, catalog)

  // 2) engine-home merges (tunnels/env/tokens) — re-sealed under this machine key.
  // A whole-file copy only when the target is absent: a plugin engine that
  // already booted has its own env.json/managed.json, so env merges PER KEY
  // (existing keys win, the plan's idempotent convergence) and managed.json
  // merges legacy TOKENS by id — its MCP defs already landed in the native
  // catalog, the editable source of truth, so the engine's own managed
  // entries are never clobbered.
  const engineHome = join(storageDir, 'engine')
  const files: string[] = []
  mkdirSync(engineHome, { recursive: true })

  if (data.tunnels.data !== undefined) {
    const target = join(engineHome, 'tunnels.json')
    if (existsSync(target)) skipped.push('tunnels.json (target exists, kept)')
    else { writeSealedJson(target, data.tunnels.data); files.push('tunnels.json') }
  }

  if (data.env.data !== undefined) {
    const target = join(engineHome, 'env.json')
    const legacyEnv = data.env.data as Record<string, unknown>
    if (!existsSync(target)) {
      writeSealedJson(target, legacyEnv)
      files.push('env.json')
    } else {
      const current = readExistingSealed<Record<string, unknown>>(target)
      if (current === undefined) skipped.push('env.json (target exists but cannot be read, kept)')
      else {
        const merged: Record<string, unknown> = { ...current }
        let added = 0
        for (const [key, value] of Object.entries(legacyEnv)) {
          if (!(key in merged)) { merged[key] = value; added++ }
        }
        if (added > 0) { writeSealedJson(target, merged); files.push('env.json (+' + String(added) + ' keys)') }
        else skipped.push('env.json (all keys already present)')
      }
    }
  }

  if (data.managed.data !== undefined) {
    const target = join(engineHome, 'managed.json')
    if (!existsSync(target)) {
      writeSealedJson(target, data.managed.data)
      files.push('managed.json')
    } else {
      const current = readExistingSealed<{ tokens?: Array<{ id?: string }> }>(target)
      const legacyTokens = ((data.managed.data as { tokens?: Array<{ id?: string }> }).tokens ?? [])
      const known = new Set((current?.tokens ?? []).map((token) => token.id))
      const fresh = legacyTokens.filter((token) => !known.has(token.id))
      if (current !== undefined && fresh.length > 0) {
        current.tokens = [...(current.tokens ?? []), ...fresh]
        writeSealedJson(target, current)
        files.push('managed.json (+' + String(fresh.length) + ' tokens)')
      } else {
        skipped.push('managed.json (target exists, kept)')
      }
    }
  }

  return { mcps, files, skipped }
}

/**
 * Read a target we have already proven exists. `readSecureJson` answers
 * undefined ONLY for a missing file — on a file that IS there it THROWS, for
 * malformed JSON or for a seal made with another machine's key. Step 1 has
 * already written the native catalog by the time these merges run, so letting
 * that escape would abort a HALF-APPLIED migration. Unreadable therefore means
 * "keep what is there", which is what the whole-file branch has always done.
 */
function readExistingSealed<T>(target: string): T | undefined {
  try {
    return readSecureJson(target) as T
  } catch {
    return undefined
  }
}

type LegacyFileLike = { path: string; state: string; data?: unknown }

function defFor(name: string, data: LegacyGatewayData): Record<string, unknown> | undefined {
  const managed = data.managed.data?.mcps?.find((m) => m.name === name && m.override !== true)
  if (managed !== undefined) return managed.def
  const override = data.managed.data?.mcps?.find((m) => m.name === name && m.override === true)
  if (override !== undefined) return override.def
  return data.gatewayConfig.data?.servers?.[name]
}

function enabledFor(name: string, data: LegacyGatewayData): boolean {
  const managed = data.managed.data?.mcps?.find((m) => m.name === name)
  if (managed !== undefined) return managed.enabled !== false
  return data.managed.data?.mcpEnabled?.[name] !== false
}

// Re-seal under THIS machine's key: read the parsed value, write a fresh
// envelope (writeSecureJson from the engine keeps format parity).
import { readSecureJson, writeSecureJson } from '../engine/secure/statefile.js'
function writeSealedJson(path: string, value: unknown): void {
  writeSecureJson(path, value)
}

