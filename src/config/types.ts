/**
 * Serializable DTOs of the unified configuration model (TASK §3). These
 * types are the ONE vocabulary shared by the host config service, the
 * browser UI, and (for native defs) the engine — no SDK objects cross any
 * boundary, and secrets never appear in list DTOs (masking happens at the
 * service edge; the sentinel round-trip below is the only secret-adjacent
 * value a client ever sees).
 *
 * Persistence sources (exactly one per definition, TASK 3.2):
 *   standard file  ~/.{claude,agents}/.mcp.json | <ws>/{.claude/,.agents/,}.mcp.json
 *   native catalog plugin-private sealed catalog (global or per-workspace)
 *   session store  plugin-private sealed per-session overrides (P2.3)
 *
 * @module dsh-mcp-adapter/config/types
 */

/** Scope levels, lowest to highest precedence. */
export type ScopeLevel = 'global' | 'project' | 'session'

/** How one MCP definition is persisted. */
export type DefSource = 'standard' | 'native' | 'session'

/**
 * One MCP server definition in the unified model. The `standard` shape is
 * exactly the .mcp.json entry dialect (command/args/env/url/headers/disabled
 * + unknown fields preserved verbatim); the `native` shape is the engine's
 * ServerDef dialect (type: mysql|redis|pg|mongo|proc|http|rest|echo, ...).
 * Both ride this one union — a definition's source decides the dialect.
 */
export interface McpDefinition {
  /** Present on BOTH dialects when the entry itself carries a disabled mark. */
  disabled?: boolean
  [key: string]: unknown
}

/** The standard .mcp.json document as loaded: full text plus parsed shape. */
export interface StandardDoc {
  /** Absolute file path (host-resolved; never client-supplied). */
  path: string
  /** Whether the file exists. A missing layer is a normal state. */
  exists: boolean
  /** Content hash (sha256 hex, first 16 chars) — the optimistic-concurrency revision. */
  revision: string
  /** The parsed top-level object, unknown fields intact. */
  doc: Record<string, unknown>
  /** The mcpServers mapping (empty when the doc has none). */
  servers: Record<string, McpDefinition>
  /** Set when the file exists but could not be loaded/parsed. */
  problem?: StandardFileProblem
}

/** Why a standard file could not be loaded (surface, never throw past preview). */
export interface StandardFileProblem {
  path: string
  code: 'NOT_JSON' | 'NOT_OBJECT' | 'BAD_SERVERS' | 'UNREADABLE' | 'SYMLINK' | 'OUT_OF_SCOPE'
  message: string
}

/** One persistence layer in a resolved scope chain, with its load state. */
export interface LayerInfo {
  /** Opaque controlled source identifier, never a client-supplied path. */
  layerId?: string
  level: ScopeLevel
  source: DefSource
  /** Display path (standard file path, or 'native:global' / 'native:<workspaceId>' / 'session:<sessionId>'). */
  label: string
  exists: boolean
  revision: string
  problem?: StandardFileProblem
}

/** One merged entry as the UI sees it (TASK 3.3: source/inherit/override/pending). */
export interface MergedEntry {
  layerId?: string
  sourceLabel?: string
  name: string
  level: ScopeLevel
  source: DefSource
  /** Definition with secrets masked (sentinel round-trip for edits). */
  def: McpDefinition
  /** True when this entry comes from a lower layer and is not overridden here. */
  inherited: boolean
  /** Names this entry overrides (lower layers mentioning the same name). */
  overrides: string[]
  /** Present-and-active vs present-but-masked (tombstone). */
  disabled: boolean
  /** Revision of the FILE this entry was read from ('' for computed layers). */
  revision: string
  /** A session-layer entry not yet effective in its session (pending, TASK 4.1). */
  pending?: boolean
}

/** Same-layer standard/native name clash (TASK 3.2: diagnosed, never silently picked). */
export interface ScopeConflict {
  scope: ScopeLevel
  name: string
  standardPath: string
  nativeLabel: string
}

/** The full preview a client renders from. */
export interface ScopePreview {
  layers: LayerInfo[]
  entries: MergedEntry[]
  conflicts: ScopeConflict[]
  problems: StandardFileProblem[]
}

/** Save operations, one transaction per call (TASK 3.4/P2.5). */
export type SaveOperation =
  | { op: 'upsert'; level: Exclude<ScopeLevel, never>; source: DefSource; name: string; def: McpDefinition; expectedRevision: string }
  | { op: 'delete'; level: ScopeLevel; source: DefSource; name: string; expectedRevision: string }
  | { op: 'setEnabled'; level: ScopeLevel; source: DefSource; name: string; enabled: boolean; expectedRevision: string }

/** Sentinel that means "keep the stored secret" in an edited def (engine mask dialect). */
export const SECRET_SENTINEL = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'

/** Explicit clear marker a client sends to delete a secret field (null = clear, TASK 3.4). */
export const SECRET_CLEAR: null = null
