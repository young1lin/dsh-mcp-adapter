/**
 * READ-ONLY access to an old local-mcp-gateway data directory (TASK P6.2):
 * loads every state file WITHOUT the auto-seal side effect the engine's own
 * readSecureJson performs on legacy plaintext (a migration PRE-CHECK must
 * never rewrite the source of truth it is inspecting). Envelopes open with
 * the machine key candidates; plaintext files parse as-is and are flagged
 * legacyPlain so the report can call the upgrade path explicit.
 *
 * @module dsh-mcp-adapter/config/legacy-read
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isSealed, unseal } from '../engine/secure/envelope.js'
import { masterKeyCandidates } from '../engine/secure/key.js'

/** One file's read outcome. */
export interface LegacyFile<T = unknown> {
  path: string
  state: 'missing' | 'sealed' | 'legacyPlain' | 'notJson' | 'undecryptable'
  data?: T
  error?: string
}

/**
 * Read one legacy state file read-only.
 * @param path - absolute file path.
 */
export function readLegacyJson<T = unknown>(path: string): LegacyFile<T> {
  if (!existsSync(path)) return { path, state: 'missing' }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return { path, state: 'notJson', error: (error as Error).message }
  }
  if (!isSealed(raw)) {
    // NEVER seal-and-rewrite here: the pre-check is a pure read (P6.2).
    return { path, state: 'legacyPlain', data: raw as T }
  }
  for (const candidate of masterKeyCandidates()) {
    try {
      return { path, state: 'sealed', data: JSON.parse(unseal(candidate.key, raw)) as T }
    } catch {
      // try the next key candidate
    }
  }
  return { path, state: 'undecryptable', error: 'no master key opens this file (copied from another machine?)' }
}

/** The whole old gateway data dir as the migration planner sees it. */
export interface LegacyGatewayData {
  root: string
  gatewayConfig: LegacyFile<{ port?: number; servers?: Record<string, Record<string, unknown>> }>
  managed: LegacyFile<{ mcps?: Array<{ name: string; def: Record<string, unknown>; enabled?: boolean; override?: boolean }>; disabledTools?: Record<string, string[]>; resourceToggles?: Record<string, boolean>; order?: string[]; groups?: string[]; mcpGroups?: Record<string, string>; tokens?: Array<{ id: string; label: string; secret: string; createdAt?: string }>; token?: string; mcpEnabled?: Record<string, boolean> }>
  tunnels: LegacyFile<{ connections?: Array<Record<string, unknown>>; rules?: Array<Record<string, unknown>> }>
  env: LegacyFile<Record<string, string>>
}

/**
 * Load the full legacy data dir (read-only). Missing dir returns all-missing.
 * @param root - the old gateway data dir (e.g. %APPDATA%/local-mcp-gateway).
 */
export function readLegacyGateway(root: string): LegacyGatewayData {
  return {
    root,
    gatewayConfig: readLegacyJson(join(root, 'gateway.config.json')),
    managed: readLegacyJson(join(root, 'managed.json')),
    tunnels: readLegacyJson(join(root, 'tunnels.json')),
    env: readLegacyJson(join(root, 'env.json')),
  }
}
