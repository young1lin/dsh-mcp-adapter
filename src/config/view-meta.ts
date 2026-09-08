/**
 * Presentation metadata for the entry list: which group an MCP is filed
 * under, and the order the user dragged it into.
 *
 * This deliberately does NOT live in any config layer. Entries are spread
 * across global/project standard files, native catalogs and session
 * overrides, so no single layer can hold an ordering for all of them; and the
 * standard files are an interop surface shared with other MCP clients, where
 * a dsh-only "group" key would be noise at best. Grouping and ordering are a
 * property of THIS panel's view, so they live in one plugin-owned file keyed
 * by entry name.
 *
 * Consequences worth knowing: metadata for an entry that disappears is inert
 * but kept (see writeViewMeta for why it is not pruned), and renaming an entry
 * through /rename carries its metadata across.
 *
 * @module dsh-mcp-adapter/config/view-meta
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeJsonAtomic } from '../engine/atomic-json.js'
import type { EntryView } from '../shared/view-order.js'

export type { EntryView } from '../shared/view-order.js'

export interface ViewMeta {
  version: 1
  entries: Record<string, EntryView>
}

export const MAX_GROUP_LENGTH = 60

export function emptyViewMeta(): ViewMeta {
  return { version: 1, entries: {} }
}

export function viewMetaPath(storageDir: string): string {
  return join(storageDir, 'ui-view.json')
}

/**
 * Read the metadata. A missing or corrupt file is EMPTY metadata, never an
 * error: losing a grouping must not take the whole entry list down with it.
 */
export async function readViewMeta(storageDir: string): Promise<ViewMeta> {
  let raw: string
  try {
    raw = await readFile(viewMetaPath(storageDir), 'utf8')
  } catch {
    return emptyViewMeta()
  }
  try {
    const doc = JSON.parse(raw) as Partial<ViewMeta>
    const entries: Record<string, EntryView> = {}
    for (const [name, value] of Object.entries(doc.entries ?? {})) {
      if (value === null || typeof value !== 'object') continue
      const view: EntryView = {}
      const group = (value as EntryView).group
      const order = (value as EntryView).order
      if (typeof group === 'string' && group.trim() !== '') view.group = group.trim().slice(0, MAX_GROUP_LENGTH)
      if (typeof order === 'number' && Number.isFinite(order)) view.order = order
      if (view.group !== undefined || view.order !== undefined) entries[name] = view
    }
    return { version: 1, entries }
  } catch {
    return emptyViewMeta()
  }
}

/**
 * Write the metadata, dropping entries that carry nothing. Returns exactly what
 * was persisted, so a caller that echoes the result back to the UI cannot
 * report a shape the file does not have.
 *
 * It deliberately does NOT prune against a set of known names, and took a
 * `known` set until it was found doing damage. This is ONE plugin-wide file,
 * whereas every caller knows only the entries of the scope it happens to be
 * serving, so "drop what I cannot see" meant that grouping an entry while
 * workspace B was selected erased every grouping made in workspace A. Metadata
 * for an entry that is genuinely gone is inert; keeping it costs a few bytes
 * and survives the entry coming back.
 */
export function writeViewMeta(storageDir: string, meta: ViewMeta): ViewMeta {
  const entries: Record<string, EntryView> = {}
  for (const [name, view] of Object.entries(meta.entries)) {
    if (view.group !== undefined || view.order !== undefined) entries[name] = view
  }
  const pruned: ViewMeta = { version: 1, entries }
  writeJsonAtomic(viewMetaPath(storageDir), pruned)
  return pruned
}

export { groupsOf, moveEntry, sortEntries } from '../shared/view-order.js'
