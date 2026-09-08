/**
 * Import, export and dialect conversion (TASK P2.5/P2.6). Import is a
 * one-shot COPY with a collision plan the caller previews first (names are
 * suffixed, never overwritten — the engine's planMcpImport naming rules);
 * "link an existing file" is a DIFFERENT feature (the file IS a standard
 * source already) and is deliberately not smuggled in here.
 *
 * Dialect conversion is explicit and honest about loss:
 *   standard -> native : command+args joins to a proc command string
 *                        (engine tokenizeCommand dialect); env/url/headers
 *                        carried; disabled maps to enabled=false.
 *   native -> standard : only proc/echo/http convert without inventing
 *                        infrastructure; mysql/redis/pg/mongo/rest have NO
 *                        standard shape — the caller is told, and the
 *        external-client story for those is the engine-endpoint export
 *        (P6), not a fake standard entry.
 *
 * @module dsh-mcp-adapter/config/transfer
 */

import { planMcpImport } from '../engine/mcp-import.js'
import type { McpDefinition } from './types.js'
import type { NativeEntry } from './native-catalog.js'
import { validateEntry } from './standard-repo.js'

/** One planned standard import row. */
export interface ImportPlanRow {
  name: string
  def: McpDefinition
  reason?: string
}

/** The plan for one import: adds (with allocated names) and skips (with reasons). */
export interface ImportPlan {
  add: ImportPlanRow[]
  skip: { name: string; reason: string }[]
}

/**
 * Plan a standard-file import against the names already taken in the target
 * scope. Pure: nothing is written, the caller previews this.
 * @param raw - the parsed source document (mcpServers/servers accepted).
 * @param taken - names already present in the target scope.
 */
export function planStandardImport(raw: unknown, taken: Set<string>): ImportPlan {
  const plan = planMcpImport(raw, { taken, gatewayPort: -1 })
  return {
    add: plan.add.map((row) => ({ name: row.name, def: row.def as unknown as McpDefinition })),
    skip: plan.skip,
  }
}

/**
 * Plan a native import (gateway.config servers dialect). Entries stay in
 * their native shape; only names are allocated.
 */
export function planNativeImport(raw: Record<string, unknown>, taken: Set<string>): ImportPlan {
  const add: ImportPlanRow[] = []
  const skip: { name: string; reason: string }[] = []
  const used = new Set(taken)
  for (const [rawName, value] of Object.entries(raw)) {
    if (value === null || typeof value !== 'object') {
      skip.push({ name: rawName, reason: 'not an object' })
      continue
    }
    const def = value as McpDefinition
    if (typeof def.type !== 'string' || def.type.length === 0) {
      skip.push({ name: rawName, reason: 'native definitions need a "type"' })
      continue
    }
    let name = rawName
    let n = 1
    while (used.has(name)) name = rawName + '-' + String(n++)
    used.add(name)
    add.push({ name, def })
  }
  return { add, skip }
}

/**
 * Convert one standard entry to the native dialect. Returns undefined when
 * the entry has no native-carrier shape (a url entry converts to a native
 * http def; command entries to proc).
 */
export function standardToNative(def: McpDefinition): NativeEntry['def'] | undefined {
  if (typeof def.url === 'string') {
    const out: McpDefinition = { type: 'http', url: def.url }
    if (typeof def.description === 'string') out.description = def.description
    if (def.headers !== undefined) out.headers = def.headers
    return out
  }
  if (typeof def.command === 'string') {
    const args = Array.isArray(def.args) ? (def.args as unknown[]).map(String) : []
    const out: McpDefinition = { type: 'proc', command: [def.command, ...args.map(quoteArg)].join(' ') }
    if (typeof def.description === 'string') out.description = def.description
    if (def.cwd !== undefined) out.cwd = def.cwd
    if (def.env !== undefined) out.env = def.env
    return out
  }
  return undefined
}

/**
 * Convert one native def to the standard dialect; undefined when there is no
 * honest standard shape (DB/rest adapters — their external-client story is
 * the engine-endpoint export, not a fake entry).
 */
export function nativeToStandard(def: McpDefinition): McpDefinition | undefined {
  if (def.type === 'proc' && typeof def.command === 'string') {
    const out: McpDefinition = {}
    if (typeof def.description === 'string') out.description = def.description
    out.command = def.command
    if (def.cwd !== undefined) out.cwd = def.cwd
    if (def.env !== undefined) out.env = def.env
    return out
  }
  if (def.type === 'http' && typeof def.url === 'string') {
    const out: McpDefinition = { url: def.url }
    if (typeof def.description === 'string') out.description = def.description
    if (def.headers !== undefined) out.headers = def.headers
    return out
  }
  if (def.type === 'echo') return { command: 'node -e ""' } // demo value; echo has no standard carrier
  return undefined
}

/** Validate a converted standard entry ahead of a write. */
export function checkConverted(name: string, def: McpDefinition): string | undefined {
  return validateEntry(name, def)
}

function quoteArg(s: string): string {
  if (!/[\s"]/.test(s)) return s
  return '"' + s.replace(/"/g, '\\"') + '"'
}
