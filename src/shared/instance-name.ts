/**
 * How a session-scoped engine instance is NAMED — in one place.
 *
 * The runtime mints `s<10 hex workspace>-<10 hex definition>-<logical name>`
 * (`instanceNameFor`, src/runtime/session-runtime.ts): the two hashes make the
 * name globally unique so a bare logical name is never addressed on the
 * engine, and the tail keeps it readable in a log directory.
 *
 * Both halves of the plugin need that rule. The runtime mints it; the engine's
 * call log has to answer the other direction — "which of these logs belong to
 * the entry the panel is showing" — because an agent's tool calls are recorded
 * under the SESSION instance, so the entry's own log stays empty however much
 * the workspace's agents have been calling it. A second copy of a naming rule
 * is a rule that drifts, so both import this.
 *
 * Kept free of node imports: esbuild pulls this into the browser bundle too.
 *
 * @module dsh-mcp-adapter/shared/instance-name
 */

/** The engine's own ceiling for an instance name (its route validator's {1,63}). */
export const INSTANCE_NAME_MAX = 63

/**
 * What the hashes and their separators occupy: s + 10 + - + 10 + -.
 *
 * The mint clips the whole name at INSTANCE_NAME_MAX, so this is exactly how
 * much room the tail has. (It used to reserve 22 and let the outer clip take
 * the extra character off a maximal tail; computing it here produces the same
 * name, which matters — the name IS an identity: an instance, its leases and
 * its log all hang off it.)
 */
const PREFIX = 1 + 10 + 1 + 10 + 1

/** The readable tail of an instance name: the logical entry name, reduced to
 *  the characters an instance name may hold, forced to start alphanumeric, and
 *  clipped so the whole name fits. */
export function instanceTail(logical: string): string {
  const safe = logical.replace(/[^A-Za-z0-9_-]/g, '_')
  const seeded = safe.length > 0 && /[A-Za-z0-9]/.test(safe[0]!) ? safe : 'x' + safe
  return seeded.slice(0, INSTANCE_NAME_MAX - PREFIX)
}

const SHAPE = /^s([0-9a-f]{10})-([0-9a-f]{10})-(.+)$/

/** The three parts of a session instance name, or undefined for anything else. */
export function parseSessionInstance(instance: string): { workspaceKey: string; defKey: string; tail: string } | undefined {
  const m = SHAPE.exec(instance)
  return m === null ? undefined : { workspaceKey: m[1]!, defKey: m[2]!, tail: m[3]! }
}

/**
 * Is `instance` a session instance minted from the entry `logical`?
 *
 * Equality on the tail, because instanceTail() already applies every reduction
 * the mint does — including the clip. A prefix test would let `alpha` claim
 * `alpha-2`'s logs, which is exactly the kind of quiet cross-wiring this
 * module exists to prevent.
 */
/**
 * The key a per-entry SETTING is filed under — the tool toggles, the resources
 * switch — for a registry name that may be either a catalog name or a minted
 * instance name.
 *
 * Instance names carry a hash of the definition, so filing a toggle under one
 * meant the setting died with the next edit to the server it belonged to, and
 * an instance minted for a session never found what the panel had saved under
 * the catalog name. What both forms share is the LOGICAL name, which is what a
 * toggle is actually about: "this entry's `web_search` is off" is true of every
 * instance of that entry.
 *
 * Catalog names go through instanceTail too, so both directions agree by
 * construction. Engine names are already `[A-Za-z0-9_-]` starting alphanumeric
 * (every name-accepting endpoint enforces it), so the only thing that can
 * change is the length clip on a name past 40 characters.
 */
export function logicalKeyOf(name: string): string {
  const parts = parseSessionInstance(name)
  return parts === undefined || parts.tail === '' ? instanceTail(name) : parts.tail
}

export function isSessionInstanceOf(instance: string, logical: string): boolean {
  const parts = parseSessionInstance(instance)
  if (parts === undefined || parts.tail === '') return false
  return parts.tail === instanceTail(logical)
}
