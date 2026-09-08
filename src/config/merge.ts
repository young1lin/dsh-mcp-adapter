/**
 * The one merge algorithm (TASK 3.3): scope precedence session > project >
 * global; a name's HIGHEST mention decides its fate, whole-entry
 * replacement — never field-stitching across sources. A mention that is
 * disabled (standard "disabled": true | native enabled: false | session
 * {disabled: true}) is a TOMBSTONE: it masks every lower source for that
 * name, which is exactly the fix for "a file-level disable resurrects
 * through discovery" — the merged view carries the name as disabled-with-
 * source, so any discovery/mount layer must skip it.
 *
 * Same-SCOPE standard/native clashes are CONFLICTS: the name is excluded
 * from the effective set and reported for an explicit rename/migrate, never
 * silently picked. Two standard files inside one project scope keep their
 * historical root-then-.agents override order and are NOT a conflict.
 *
 * @module dsh-mcp-adapter/config/merge
 */

import type {
  LayerInfo, McpDefinition, MergedEntry, ScopeConflict, ScopeLevel, ScopePreview, StandardFileProblem,
} from './types.js'

/** Precedence rank per scope level (higher wins). */
const RANK: Record<ScopeLevel, number> = { global: 0, project: 1, session: 2 }

/** One name-mention as the chain walker produces them (lowest precedence first). */
export interface Mention {
  layerId?: string
  name: string
  level: ScopeLevel
  source: 'standard' | 'native' | 'session'
  /** Display origin (file path / catalog label / session label). */
  label: string
  def: McpDefinition
  disabled: boolean
  revision: string
}

/**
 * Merge a precedence-ordered mention list into preview entries + conflicts.
 * @param mentions - in ANY order; precedence decides, not list position.
 * @param viewLevel - the scope the UI is looking from (sets `inherited`).
 */
export function mergeMentions(mentions: Mention[], viewLevel: ScopeLevel): { entries: MergedEntry[]; conflicts: ScopeConflict[] } {
  const byName = new Map<string, Mention[]>()
  for (const mention of mentions) {
    const list = byName.get(mention.name) ?? []
    list.push(mention)
    byName.set(mention.name, list)
  }

  const entries: MergedEntry[] = []
  const conflicts: ScopeConflict[] = []

  for (const [name, list] of byName) {
    // Same-scope standard/native clash -> conflict; the name is excluded from
    // the effective set and reported for an explicit rename/migrate.
    let conflicted = false
    for (const level of ['global', 'project'] as const) {
      const std = list.find((m) => m.level === level && m.source === 'standard')
      const nat = list.find((m) => m.level === level && m.source === 'native')
      if (std !== undefined && nat !== undefined) {
        conflicts.push({ scope: level, name, standardPath: std.label, nativeLabel: nat.label })
        conflicted = true
      }
    }
    if (conflicted) continue

    // Precedence order: scope level first; WITHIN one level+source the chain
    // walks files in their historical order (project root before .agents), so
    // the LAST equal-rank mention is the operative one (later file wins).
    const indexed = list.map((m, index) => ({ m, index }))
    indexed.sort((a, b) => RANK[a.m.level] - RANK[b.m.level] || a.index - b.index)
    const winner = indexed[indexed.length - 1]!.m
    const overrides = indexed
      .filter((x) => x.m !== winner)
      .map((x) => x.m.label)
    entries.push({
      name,
      layerId: winner.layerId,
      sourceLabel: winner.label,
      level: winner.level,
      source: winner.source,
      def: winner.def,
      inherited: RANK[winner.level] < RANK[viewLevel],
      overrides,
      disabled: winner.disabled,
      revision: winner.revision,
      ...(winner.level === 'session' ? { pending: true } : {}),
    })
  }

  entries.sort((a, b) => a.name.localeCompare(b.name))
  return { entries, conflicts }
}

/** Assemble the final preview (layers + entries + conflicts + problems). */
export function buildPreview(
  layers: LayerInfo[],
  mentions: Mention[],
  viewLevel: ScopeLevel,
  problems: StandardFileProblem[],
): ScopePreview {
  const { entries, conflicts } = mergeMentions(mentions, viewLevel)
  return { layers, entries, conflicts, problems }
}
