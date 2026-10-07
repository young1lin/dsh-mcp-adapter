/**
 * Pure scope/layer logic for the browser half (no React, no fetch — fully
 * unit-testable): the layerId vocabulary the backend mints, which layers the
 * Add-wizard may target, how a save body is addressed (R5: layer + revision
 * captured at OPEN time, never re-derived at save time), and how the session
 * tab classifies snapshot / current / pending.
 *
 * NOTHING here ever handles a filesystem path: layers are addressed by the
 * opaque layerId only; labels exist for display and never cross back.
 */

import type { LayerId, Preview, PreviewEntry, PreviewLayer, SaveEntryBody } from './api.js'

/** The layer identities this client knows by name (backend contract R5). */
export const KNOWN_LAYER_IDS: readonly LayerId[] = [
  'global:standard',
  'global:claude',
  'project:root',
  'project:agents',
  'project:claude',
  'global:native',
  'project:native',
  'session:overrides',
]

/** i18n key for each known layer id (unknown ids fall back to the raw id). */
export const LAYER_NAME_KEYS: Record<string, string> = {
  'global:standard': 'layerGlobalStandard',
  'global:claude': 'layerGlobalClaude',
  'project:root': 'layerProjectRoot',
  'project:agents': 'layerProjectAgents',
  'project:claude': 'layerProjectClaude',
  'global:native': 'layerGlobalNative',
  'project:native': 'layerProjectNative',
  'session:overrides': 'layerSessionOverrides',
}

/** Layers the Add-wizard may target, in display order (session only in the session tab). */
export const CREATE_TARGETS: readonly LayerId[] = [
  'global:standard',
  'global:claude',
  'project:root',
  'project:agents',
  'project:claude',
  'global:native',
  'project:native',
]

/**
 * The layerId of a preview layer: the backend field when present, else the
 * pre-layerId fallback derived from level+source. Claude and project:agents
 * are UNREACHABLE in the fallback (multiple files share level/source)
 * — that layer only becomes addressable once the backend ships layerId.
 */
export function layerIdOfLayer(layer: PreviewLayer): LayerId | undefined {
  if (typeof layer.layerId === 'string' && layer.layerId.length > 0) return layer.layerId
  if (layer.source === 'native') {
    if (layer.level === 'global') return 'global:native'
    if (layer.level === 'project') return 'project:native'
    return undefined
  }
  if (layer.source === 'standard') {
    if (layer.level === 'global') return 'global:standard'
    if (layer.level === 'project') return 'project:root'
    return undefined
  }
  if (layer.source === 'session') return 'session:overrides'
  return undefined
}

/** The layerId an ENTRY lives on (its own mention's layer, not the view level). */
export function layerIdOfEntry(entry: PreviewEntry): LayerId | undefined {
  if (typeof entry.layerId === 'string' && entry.layerId.length > 0) return entry.layerId
  if (entry.source === 'session') return 'session:overrides'
  if (entry.source === 'native') return entry.level === 'global' ? 'global:native' : entry.level === 'project' ? 'project:native' : undefined
  if (entry.source === 'standard') return entry.level === 'global' ? 'global:standard' : entry.level === 'project' ? 'project:root' : undefined
  return undefined
}

/** Which wizard targets exist in this preview (by layerId, deduped, CREATE_TARGETS order). */
export function createTargetsFor(preview: Preview | undefined): LayerId[] {
  if (preview === undefined) return []
  const present = new Set(preview.layers.map((l) => layerIdOfLayer(l)).filter((x): x is LayerId => x !== undefined))
  return CREATE_TARGETS.filter((id) => present.has(id))
}

export interface LayerAddress {
  /** Opaque layer id when the backend provided one (or it is derivable). */
  layerId?: LayerId
  /** Legacy addressing (pre-layerId backends). */
  level: string
  source: string
}

/** Resolve one layer's address by layerId inside a preview (layer-level match). */
export function findLayer(preview: Preview | undefined, layerId: LayerId): PreviewLayer | undefined {
  if (preview === undefined) return undefined
  return preview.layers.find((l) => layerIdOfLayer(l) === layerId)
}

/**
 * The address + revision the editor must retain from OPEN time (R5). The
 * revision is the one the entry/layer carried when the user opened the
 * editor — saving NEVER re-reads the preview, so a mid-edit external change
 * surfaces as a 409 instead of silently overwriting.
 */
export function captureFromEntry(entry: PreviewEntry): LayerAddress & { revision: string; name: string } {
  return {
    ...(layerIdOfEntry(entry) !== undefined ? { layerId: layerIdOfEntry(entry) } : {}),
    level: entry.level,
    source: entry.source,
    revision: entry.revision,
    name: entry.name,
  }
}

export function captureFromLayer(layer: PreviewLayer): LayerAddress & { revision: string } {
  return {
    ...(layerIdOfLayer(layer) !== undefined ? { layerId: layerIdOfLayer(layer) } : {}),
    level: layer.level,
    source: layer.source,
    revision: layer.revision,
  }
}

/**
 * Build the save body from a captured address. Asserts the R5 invariants:
 * the expectedRevision is the CAPTURED one, layerId rides when known, and no
 * label/path ever enters the payload.
 */
export function buildSaveBody(captured: LayerAddress & { revision: string }, name: string, def: Record<string, unknown> | null): SaveEntryBody {
  const body: SaveEntryBody = {
    ...(captured.layerId !== undefined ? { layerId: captured.layerId } : {}),
    level: captured.level,
    source: captured.source,
    name,
    def,
    expectedRevision: captured.revision,
  }
  return body
}

/** A save failure that means "the layer changed since open" (keep the draft!). */
export function isConflictRejection(error: unknown): boolean {
  const e = error as { code?: string; status?: number }
  return e?.code === 'CONFLICT' || e?.status === 409
}

/** Session-tab classification: what IS effective now vs what is only PENDING. */
export interface SessionClassification {
  /** Session-layer overrides (def or disable) — pending until a later session adopts them. */
  pending: PreviewEntry[]
  /** Entries effective from this session's start (global/project layers). */
  current: PreviewEntry[]
}

export function classifySessionEntries(entries: PreviewEntry[]): SessionClassification {
  const pending: PreviewEntry[] = []
  const current: PreviewEntry[] = []
  for (const entry of entries) {
    if (entry.source === 'session' || entry.pending === true) pending.push(entry)
    else current.push(entry)
  }
  return { pending, current }
}

/** Public tool names in the snapshot that belong to one MCP (publicNameLite dialect: mcp__<name>__<tool>). */
export function snapshotToolsOf(snapshot: { tools: string[] } | undefined): string[] {
  return snapshot?.tools ?? []
}

/** Short layer tag for a row chip, e.g. 'project:root' → 'root'. */
export function shortLayerTag(layerId: LayerId | undefined): string {
  if (layerId === undefined) return ''
  const i = layerId.indexOf(':')
  return i < 0 ? layerId : layerId.slice(i + 1)
}
