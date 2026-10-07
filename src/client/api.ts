/** Same-origin fetch helpers over the /dsh-mcp-manager bridge. */

const PREFIX = '/dsh-mcp-manager'

export interface ApiError {
  message: string
  code?: string
  status: number
}

async function call(method: string, path: string, body?: unknown, query?: Record<string, string>): Promise<unknown> {
  const qs = new URLSearchParams(query ?? {}).toString()
  const res = await fetch(PREFIX + path + (qs.length > 0 ? '?' + qs : ''), {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let json: unknown = undefined
  try { json = await res.json() } catch { /* empty body */ }
  if (!res.ok) {
    const err = (json as { error?: string; code?: string }) ?? {}
    throw { message: err.error ?? res.statusText, code: err.code, status: res.status } satisfies ApiError
  }
  return json
}

/**
 * Opaque layer identity the HOST mints (R5 fix): the browser never addresses
 * a persistence layer by filesystem path — only by this id plus the revision
 * it captured when the editor was opened. Known values (backend contract):
 * global:standard, global:claude, project:root, project:agents, project:claude, global:native,
 * project:native, session:overrides. Unknown values pass through so a newer
 * backend can add layers without a client rebuild.
 */
export type LayerId = 'global:standard' | 'global:claude' | 'project:root' | 'project:agents' | 'project:claude' | 'global:native' | 'project:native' | 'session:overrides' | (string & {})

/** Scope ids the bridge accepts as query params (ws = workspaceId, ss = sessionId). */
export interface ScopeIds {
  ws?: string
  ss?: string
}

function scopeQuery(scope?: ScopeIds): Record<string, string> {
  if (scope === undefined) return {}
  const out: Record<string, string> = {}
  if (scope.ws !== undefined && scope.ws !== '') out.ws = scope.ws
  if (scope.ss !== undefined && scope.ss !== '') out.ss = scope.ss
  return out
}

export interface PreviewEntry {
  name: string
  level: string
  source: string
  /** Layer the winning mention was read from (backend contract R5). */
  layerId?: LayerId
  def: Record<string, unknown>
  inherited: boolean
  overrides: string[]
  disabled: boolean
  revision: string
  pending?: boolean
}

export interface PreviewLayer {
  level: string
  source: string
  /** Backend-minted layer identity; absent on pre-layerId backends. */
  layerId?: LayerId
  /** Host display label (may contain a path) — NEVER sent back to the host. */
  label: string
  exists: boolean
  revision: string
  problem?: { code: string; message: string }
}

/** Registration snapshot recorded when this session's tools were installed. */
export interface SessionSnapshot {
  revision: string
  registeredAt: string
  tools: string[]
}

export interface Preview {
  layers: PreviewLayer[]
  entries: PreviewEntry[]
  conflicts: Array<{ scope: string; name: string; standardPath: string; nativeLabel: string }>
  problems: Array<{ path: string; code: string; message: string }>
}

export interface SessionView {
  sessionId: string
  revision: string
  snapshot?: SessionSnapshot
}

/** Save addressing for one entry (R5): layerId when known, level+source fallback. */
export interface SaveEntryBody {
  layerId?: LayerId
  level: string
  source: string
  name: string
  /** null deletes the entry at this layer (= re-inherit). */
  def: Record<string, unknown> | null
  expectedRevision: string
}

export interface SetEnabledBody {
  layerId?: LayerId
  level: string
  name: string
  enabled: boolean
  expectedRevision: string
}

// --- engine-plane DTOs ------------------------------------------------------------------------

/**
 * One row of an MCP's call log.
 *
 * These names are the ENGINE's (src/engine/calls.ts CallEntry), not names
 * chosen here. An earlier version of this interface invented `ts`, `source`
 * and a string `preview`; the engine sends `at`, `via` and a BOOLEAN
 * `preview` (meaning "`output` is only the head of the reply"). TypeScript
 * had nothing to compare the guess against, so the panel type-checked
 * cleanly, rendered two blank columns, and crashed the whole settings
 * section on `preview.slice is not a function`.
 */
export interface CallRow {
  seq: number
  /** ISO timestamp of the call. */
  at: string
  tool: string
  /** 'mcp' for a client on the HTTP endpoint, 'panel' for this UI's Run tab. */
  via?: string
  /** Token label that authenticated the request; absent for panel calls. */
  client?: string
  ok?: boolean
  ms?: number
  /** Arguments as JSON, secret-looking values redacted. */
  args?: string
  /** The reply, or the error message. Clipped when `preview` is true. */
  output?: string
  /** Length of the FULL reply, even when `output` is only its head. */
  chars?: number
  /** True when `output` is only the head of the reply. */
  preview?: boolean
  /** True when the complete reply is still on disk and can be fetched. */
  body?: boolean
  /** True when the reply was written but has since been pruned. */
  bodyGone?: boolean
}

/**
 * One call log that belongs to an entry. A DSH agent's tool calls are recorded
 * under the SESSION instance the runtime minted, not under the entry, so the
 * entry's own log is only ever half the story.
 */
export interface CallSource {
  name: string
  session: boolean
  lastAt?: string
  lastSeq?: number
}

export interface CallsPage {
  name: string
  calls: CallRow[]
  /**
   * True when older pages exist behind this one. The call log is a tail —
   * the engine never counts the whole file, so there is no total here and
   * the pager must not pretend otherwise.
   */
  more?: boolean
  page: number
  pageSize?: number
  /** Whatever a spawned child has written to stderr, as the engine captured it. */
  stderr?: string
  /** The hosting adapter's kind and state — what an EMPTY stderr has to be read against. */
  type?: string
  lifecycle?: string
}

/** One host workspace (GET /workspaces): id is the ONLY value ever sent back. */
export interface WorkspaceItem {
  id: string
  path: string
  title?: string
}

/**
 * The answer of a draft-definition probe. `testable:false` is not a failure —
 * it means the type has no meaningful probe (a proc MCP is "tested" by
 * starting it), and `types` lists the ones that do.
 */
export interface ConnTest {
  testable: boolean
  types?: string[]
  ok?: boolean
  ms?: number
  status?: number
  error?: string
}

/** Panel presentation metadata: which group an entry is in, and its order. */
export interface ViewMeta {
  version: number
  entries: Record<string, { group?: string; order?: number }>
  groups: string[]
}

/**
 * One past run of a tool, EXACTLY as `src/engine/calls.ts` records it.
 *
 * `args` is a clipped one-line preview (96 chars) sized to be a row label, and
 * `at` is the ISO timestamp — the shape this interface used to declare (`ts`, a
 * parsed `args` object) was a guess the engine has never sent, so the rows came
 * out blank and "reuse" wrote a quoted string into the argument form. The
 * arguments to replay are fetched by `seq`; this string is never the payload.
 */
export interface ToolRun {
  seq: number
  at: string
  via: string
  client?: string
  ok: boolean
  ms: number
  args: string
}

/** Past runs of one tool, newest first, one entry per DISTINCT argument set. */
export interface ToolHistory {
  tool: string
  entries: ToolRun[]
}

export interface ResourceRead {
  ok: boolean
  mimeType?: string
  text?: string
}

/** One row of a bulk-import dry run: the name that WOULD be allocated. */
export interface ImportPlanRow {
  name: string
  def: Record<string, unknown>
}

export interface ImportPreview {
  layerId: string
  add: ImportPlanRow[]
  skip: Array<{ name: string; reason: string }>
}

export interface ImportResult {
  layerId: string
  added: string[]
  failed: Array<{ name: string; error: string }>
  skip: Array<{ name: string; reason: string }>
  revision: string
}

export const api = {
  // --- configuration plane ---------------------------------------------------------------------
  preview: (scope?: ScopeIds) => call('GET', '/preview', undefined, scopeQuery(scope)) as Promise<Preview>,
  workspaces: () => call('GET', '/workspaces') as Promise<{ items: WorkspaceItem[] }>,
  sessionView: (ss: string) => call('GET', '/session', undefined, { ss }) as Promise<SessionView>,
  saveEntry: (body: SaveEntryBody, scope?: ScopeIds) => call('POST', '/entry', body, scopeQuery(scope)) as Promise<{ revision: string }>,
  setEnabled: (body: SetEnabledBody, scope?: ScopeIds) => call('POST', '/enabled', body, scopeQuery(scope)) as Promise<{ revision: string }>,
  /** Panel-only grouping + manual order (never written into a config layer). */
  view: (scope?: ScopeIds) => call('GET', '/view', undefined, scopeQuery(scope)) as Promise<ViewMeta>,
  viewSet: (body: { name: string; group?: string | null; move?: 'up' | 'down' }, scope?: ScopeIds) =>
    call('POST', '/view', body, scopeQuery(scope)) as Promise<ViewMeta>,
  /** Rename on the entry's own layer (create the new name, drop the old one). */
  renameEntry: (body: { layerId: string; from: string; to: string; def: Record<string, unknown>; expectedRevision: string }, scope?: ScopeIds) =>
    call('POST', '/rename', body, scopeQuery(scope)) as Promise<{ from: string; to: string; revision: string }>,
  /** Dry run: what a pasted document WOULD add to this layer, and what it skips. */
  importPlan: (layerId: string, text: string, scope?: ScopeIds) =>
    call('POST', '/import', { layerId, text }, scopeQuery(scope)) as Promise<ImportPreview>,
  /** Same parse, then one save per entry. Reports exactly what landed. */
  importApply: (layerId: string, text: string, scope?: ScopeIds) =>
    call('POST', '/import', { layerId, text, apply: true }, scopeQuery(scope)) as Promise<ImportResult>,

  // --- engine plane -----------------------------------------------------------------------------
  engine: () => call('GET', '/engine') as Promise<Record<string, unknown>>,
  mcp: (name: string, action: string, cursor?: string) => call('GET', '/mcp/' + encodeURIComponent(name) + '/' + action, undefined, cursor !== undefined ? { cursor } : {}) as Promise<Record<string, unknown>>,
  mcpPost: (name: string, action: string, body: Record<string, unknown>, scope?: ScopeIds) => call('POST', '/mcp/' + encodeURIComponent(name) + '/' + action, body, scopeQuery(scope)) as Promise<Record<string, unknown>>,

  /** Probe a DRAFT definition before saving it. Never hosts or persists anything. */
  mcpTest: (def: Record<string, unknown>) => call('POST', '/mcp/test', { def }) as Promise<ConnTest>,
  /** Read ONE resource's content from a hosted MCP. */
  mcpResource: (name: string, uri: string) =>
    call('GET', '/mcp/' + encodeURIComponent(name) + '/resource', undefined, { uri }) as Promise<ResourceRead>,
  /** The logs that belong to this entry: its own, plus each session's. */
  mcpCallSources: (name: string) =>
    call('GET', '/mcp/' + encodeURIComponent(name) + '/call-sources') as Promise<{ sources: CallSource[] }>,
  mcpClearCalls: (name: string) => call('DELETE', '/mcp/' + encodeURIComponent(name) + '/calls') as Promise<{ ok: boolean }>,
  /** Past calls of ONE tool, newest first — the Run tab replays arguments from these. */
  mcpToolHistory: (name: string, tool: string, q?: string) =>
    call('GET', '/mcp/' + encodeURIComponent(name) + '/history', undefined, {
      tool, ...(q !== undefined && q !== '' ? { q } : {}),
    }) as Promise<ToolHistory>,

  // --- calls -------------------------------------------------------------------------------------
  mcpCalls: (name: string, page = 0) => call('GET', '/mcp/' + encodeURIComponent(name) + '/calls', undefined, { page: String(page) }) as Promise<CallsPage>,
  mcpCall: (name: string, seq: number) => call('GET', '/mcp/' + encodeURIComponent(name) + '/calls/' + String(seq)) as Promise<{ name: string; call: Record<string, unknown> }>,

}

/** True when an api failure is the bridge's "no route" answer (endpoint not wired yet). */
export function isNoRoute(error: unknown): boolean {
  const e = error as { message?: string }
  return typeof e?.message === 'string' && e.message.includes('no route for ')
}
