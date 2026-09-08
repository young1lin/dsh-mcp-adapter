/**
 * The pure grouping/ordering rules for the entry list, shared by the host
 * (which persists the metadata) and the browser bundle (which renders it).
 * Kept free of node imports on purpose: esbuild pulls this into the client.
 *
 * @module dsh-mcp-adapter/shared/view-order
 */

/** What the panel remembers about one entry. Both fields are optional. */
export interface EntryView {
  group?: string
  /** Sort key within the bucket. Sparse, and never renumbered on read. */
  order?: number
}

/** Sentinel group that sorts after every real name, so ungrouped comes last. */
const UNGROUPED = '￿'

/**
 * Order entries for display: grouped ones first (by group name), ungrouped
 * last, and within a bucket by explicit order then name. Total and stable —
 * two entries compare equal only when their names do.
 */
export function sortEntries<T extends { name: string }>(
  entries: readonly T[], views: Readonly<Record<string, EntryView>>,
): T[] {
  const keyOf = (entry: T) => {
    const view = views[entry.name]
    return {
      group: view?.group ?? UNGROUPED,
      order: view?.order ?? Number.MAX_SAFE_INTEGER,
      name: entry.name,
    }
  }
  return [...entries].sort((a, b) => {
    const ka = keyOf(a), kb = keyOf(b)
    if (ka.group !== kb.group) return ka.group.localeCompare(kb.group)
    if (ka.order !== kb.order) return ka.order - kb.order
    return ka.name.localeCompare(kb.name)
  })
}

/**
 * Move one entry one slot within its OWN bucket, renumbering that bucket
 * densely so repeated moves stay predictable. Returns the new view map; a
 * move off either end is a no-op that returns the input unchanged.
 */
export function moveEntry<T extends { name: string }>(
  entries: readonly T[], views: Readonly<Record<string, EntryView>>, name: string, delta: -1 | 1,
): Record<string, EntryView> {
  const group = views[name]?.group
  const bucket = sortEntries(entries, views).filter((e) => views[e.name]?.group === group)
  const at = bucket.findIndex((e) => e.name === name)
  const to = at + delta
  if (at === -1 || to < 0 || to >= bucket.length) return { ...views }
  const reordered = [...bucket]
  const [moved] = reordered.splice(at, 1)
  reordered.splice(to, 0, moved!)
  const next: Record<string, EntryView> = { ...views }
  reordered.forEach((entry, i) => { next[entry.name] = { ...next[entry.name], order: i } })
  return next
}

/** Every group in use, sorted by name. */
export function groupsOf(views: Readonly<Record<string, EntryView>>): string[] {
  const seen = new Set<string>()
  for (const view of Object.values(views)) {
    if (view.group !== undefined) seen.add(view.group)
  }
  return [...seen].sort((a, b) => a.localeCompare(b))
}
