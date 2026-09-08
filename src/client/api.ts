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
 * global:standard, project:root, project:agents, global:native,
 * project:native, session:overrides. Unknown values pass through so a newer
 * backend can add layers without a client rebuild.
 */
export type LayerId = 'global:standard' | 'project:root' | 'project:agents' | 'global:native' | 'project:native' | 'session:overrides' | (string & {})

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

// --- engine-plane DTOs (typed views; some routes are pending backend wiring) -----------------

export interface TokenRow {
  id: string
  label: string
  createdAt: string
  lastUsedAt?: string
}

export interface TokenSecret {
  id: string
  label: string
  secret: string
  createdAt?: string
}

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

/**
 * One recorded request on the engine's HTTP endpoint.
 *
 * Engine names again (src/engine/traffic.ts TrafficRow): `at`, not `ts`;
 * `params`, not `preview`; and there is no HTTP `status` at all — this log
 * records JSON-RPC calls, whose outcome is `ok`.
 */
export interface TrafficRow {
  seq: number
  /** ISO timestamp. */
  at: string
  mcp: string
  method: string
  /** Token label that authenticated the request; absent for panel calls. */
  client?: string
  /** Self-reported app name from the MCP initialize handshake. */
  clientName?: string
  clientVersion?: string
  /** Redacted, clipped summary of the request params. */
  params?: string
  ok?: boolean
  ms?: number
  /** True when a reply was recorded and can be expanded. */
  hasResponse?: boolean
}

/** One caller the log has seen, as the engine groups them. */
export interface TrafficClient {
  /** Stable grouping key — what the `client` filter takes. */
  key: string
  /** Display name (the self-reported app name when it gave one). */
  label: string
  tokens?: string[]
  mcps?: string[]
  count?: number
  lastAt?: string
  lastSeq?: number
}

export interface TrafficPage {
  rows: TrafficRow[]
  /** Rows matching the filter, across every page. */
  total: number
  /** Rows in the ring before the filter — the "n of m" readout. */
  totalUnfiltered?: number
  page: number
  pageSize?: number
  more?: boolean
  clients: TrafficClient[]
}

export interface DataConnection {
  name: string
  dialect: string
  label: string
  readonly: boolean
  state: string
  editable: boolean
}

export interface DataTablesPage {
  tables: Array<{ name: string; rows?: number }>
  total: number
  page: number
}

export interface DataGridPage {
  columns: Array<{ name: string; type?: string }>
  rows: Array<Record<string, unknown>>
  total: number
  offset: number
  limit: number
  editable: boolean
  reason?: string
}

export interface QueryResult {
  columns: Array<{ name: string; type?: string }>
  rows: Array<Record<string, unknown>>
  truncated?: boolean
}

/** describeTable: the Structure tabs (columns / indexes / foreign keys / DDL). */
export interface DataStructure {
  schema: string
  table: string
  columns: Array<{ name: string; dataType: string; nullable: boolean; isPrimaryKey: boolean; defaultValue?: string | null; comment?: string | null }>
  primaryKey: string[]
  indexes: Array<{ name: string; unique: boolean; primary: boolean; columns: string[] }>
  foreignKeys: Array<{ name: string; columns: string[]; refTable: string; refColumns: string[] }>
  ddl: string
}

/** exportTable: the whole (capped) table as one CSV/JSON body. */
export interface DataExport {
  format: 'csv' | 'json'
  columns: string[]
  rows: number
  capped: boolean
  body: string
}

/** One SCAN page of redis keys. `cursor` is passed back to continue. */
export interface RedisKeysPage {
  keys: Array<{ key: string; type: string; ttl?: number; size?: number }>
  cursor: string
  done: boolean
  total?: number
}

export interface MongoCollections {
  collections: Array<{ name: string; type: string; approxDocs: number; size: string }>
}

export interface MongoDocsPage {
  collection: string
  documents: Array<Record<string, unknown>>
  total: number
  offset: number
  limit: number
  fields: string[]
}

/** One filter clause on the grid (the engine caps these at 16). */
export interface DataFilter {
  column: string
  op: string
  value?: string
}

/**
 * The one HTTP endpoint every MCP is served through, as the panel sees it.
 * `locked` means the plugin config decided it, so the switch is a display of
 * someone else's decision and must not pretend to be editable.
 */
export interface ListenerState {
  enabled: boolean
  port: number
  locked: boolean
  /** What the panel stored, when it has stored anything. */
  stored?: { enabled: boolean; port: number }
  /** Set on a save: the supervisor binds at the next plugin load, not now. */
  restartRequired?: boolean
  /** What the endpoint is doing RIGHT NOW, which is not always the intent. */
  active?: boolean
  activePort?: number
  /** Why the intent and the outcome differ — a port someone else holds. */
  problem?: string
}

export interface EnvVarRow {
  name: string
}

/** One host workspace (GET /workspaces): id is the ONLY value ever sent back. */
export interface WorkspaceItem {
  id: string
  path: string
  title?: string
}

export interface BackupDocument {
  version: number
  generatedAt: string
  payload: Record<string, unknown>
}

export interface RestoreResult {
  restored: Record<string, number>
  skipped?: Array<{ layerId: string; reason: string }>
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

  // --- engine plane (existing) -----------------------------------------------------------------
  engine: () => call('GET', '/engine') as Promise<Record<string, unknown>>,
  memory: (tree: boolean) => call('GET', '/memory', undefined, tree ? { tree: '1' } : {}) as Promise<Record<string, unknown>>,
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

  // --- calls / traffic (typed; bridge routes pending backend wiring) ---------------------------
  mcpCalls: (name: string, page = 0) => call('GET', '/mcp/' + encodeURIComponent(name) + '/calls', undefined, { page: String(page) }) as Promise<CallsPage>,
  mcpCall: (name: string, seq: number) => call('GET', '/mcp/' + encodeURIComponent(name) + '/calls/' + String(seq)) as Promise<{ name: string; call: Record<string, unknown> }>,
  traffic: (filter: { mcp?: string; client?: string; method?: string; actionsOnly?: boolean; page?: number; pageSize?: number } = {}) =>
    call('GET', '/traffic', undefined, {
      ...(filter.mcp !== undefined && filter.mcp !== '' ? { mcp: filter.mcp } : {}),
      ...(filter.client !== undefined && filter.client !== '' ? { client: filter.client } : {}),
      ...(filter.method !== undefined && filter.method !== '' ? { method: filter.method } : {}),
      ...(filter.actionsOnly === true ? { actions: '1' } : {}),
      ...(filter.page !== undefined ? { page: String(filter.page) } : {}),
      ...(filter.pageSize !== undefined ? { pageSize: String(filter.pageSize) } : {}),
    }) as Promise<TrafficPage>,
  trafficEntry: (seq: number) => call('GET', '/traffic/' + String(seq)) as Promise<Record<string, unknown>>,
  trafficClear: (client?: string) => call('DELETE', '/traffic', undefined, client !== undefined && client !== '' ? { client } : {}) as Promise<{ ok: boolean }>,

  // --- data view (read-only first pass; bridge routes pending backend wiring) ------------------
  dataConnections: () => call('GET', '/data') as Promise<{ connections: DataConnection[] }>,
  dataTables: (name: string, grep?: string, page = 0) => call('GET', '/data/' + encodeURIComponent(name) + '/tables', undefined, {
    page: String(page),
    ...(grep !== undefined && grep !== '' ? { grep } : {}),
  }) as Promise<DataTablesPage>,
  dataRead: (name: string, table: string, offset = 0, limit = 50, sort?: { order: string; dir: 'asc' | 'desc' }, filters?: DataFilter[]) =>
    call('GET', '/data/' + encodeURIComponent(name) + '/data', undefined, {
      table,
      offset: String(offset),
      limit: String(limit),
      ...(sort !== undefined ? { order: sort.order, dir: sort.dir } : {}),
      ...(filters !== undefined && filters.length > 0 ? { filters: JSON.stringify(filters) } : {}),
    }) as Promise<DataGridPage>,
  dataStructure: (name: string, table: string) =>
    call('GET', '/data/' + encodeURIComponent(name) + '/schema', undefined, { table }) as Promise<DataStructure>,
  dataExport: (name: string, table: string, format: 'csv' | 'json', limit = 1000) =>
    call('GET', '/data/' + encodeURIComponent(name) + '/export', undefined, { table, format, limit: String(limit) }) as Promise<DataExport>,
  // redis
  redisKeys: (name: string, pattern: string, cursor = '', type = '') =>
    call('GET', '/data/' + encodeURIComponent(name) + '/keys', undefined, {
      ...(pattern !== '' ? { pattern } : {}),
      ...(cursor !== '' ? { cursor } : {}),
      ...(type !== '' ? { type } : {}),
    }) as Promise<RedisKeysPage>,
  redisKey: (name: string, key: string) =>
    call('GET', '/data/' + encodeURIComponent(name) + '/key', undefined, { key }) as Promise<Record<string, unknown>>,
  redisCommand: (name: string, command: string) =>
    call('POST', '/data/' + encodeURIComponent(name) + '/command', { command, confirm: true }) as Promise<{ reply: unknown }>,
  // mongo
  mongoCollections: (name: string, grep = '') =>
    call('GET', '/data/' + encodeURIComponent(name) + '/collections', undefined, { ...(grep !== '' ? { grep } : {}) }) as Promise<MongoCollections>,
  mongoDocs: (name: string, collection: string, filter = '', offset = 0, limit = 50) =>
    call('GET', '/data/' + encodeURIComponent(name) + '/docs', undefined, {
      collection, offset: String(offset), limit: String(limit),
      ...(filter.trim() !== '' ? { filter } : {}),
    }) as Promise<MongoDocsPage>,
  dataQuery: (name: string, sql: string, limit = 100) => call('POST', '/data/' + encodeURIComponent(name) + '/query', { sql, limit }) as Promise<QueryResult>,

  // --- tokens / env / backup (bridge routes pending backend wiring) ----------------------------
  tokens: () => call('GET', '/tokens') as Promise<{ tokens: TokenRow[]; tokenEnv: string }>,
  tokenCreate: (label: string) => call('POST', '/tokens', { label }) as Promise<TokenSecret>,
  tokenSecret: (id: string) => call('GET', '/tokens/' + encodeURIComponent(id) + '/secret') as Promise<TokenSecret>,
  tokenRotate: (id: string) => call('POST', '/tokens/' + encodeURIComponent(id) + '/rotate') as Promise<TokenSecret>,
  tokenRevoke: (id: string) => call('DELETE', '/tokens/' + encodeURIComponent(id)) as Promise<{ ok: boolean }>,
  /** The MCP endpoint: whether it is published, and on what port. */
  listener: () => call('GET', '/listener') as Promise<ListenerState>,
  listenerSave: (enabled: boolean, port: number) => call('POST', '/listener', { enabled, port }) as Promise<ListenerState>,
  envList: () => call('GET', '/env') as Promise<{ vars: EnvVarRow[] }>,
  envSet: (name: string, value: string) => call('POST', '/env', { name, value }) as Promise<{ ok: boolean }>,
  envDelete: (name: string) => call('DELETE', '/env/' + encodeURIComponent(name)) as Promise<{ ok: boolean }>,
  backupExport: () => call('GET', '/backup/export') as Promise<BackupDocument>,
  backupRestore: (payload: Record<string, unknown>, mode: 'merge' | 'replace') => call('POST', '/backup/restore', { payload, mode }) as Promise<RestoreResult>,

  // --- tunnels (existing) ----------------------------------------------------------------------
  tunnels: () => call('GET', '/tunnels') as Promise<Record<string, unknown>>,
  tunnelOp: (op: string, params: Record<string, unknown>) => call('POST', '/tunnels', { op, params }) as Promise<Record<string, unknown>>,
}

/** True when an api failure is the bridge's "no route" answer (endpoint not wired yet). */
export function isNoRoute(error: unknown): boolean {
  const e = error as { message?: string }
  return typeof e?.message === 'string' && e.message.includes('no route for ')
}
