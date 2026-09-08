/** Explicit private-IPC management operations, not an HTTP proxy. */
import type { IpcMethod } from './ipc-service.js'
import { readEnvStore, writeEnvStore } from './secure/envstore.js'
import { readCalls, readCall, clearCalls, listCallSources, readToolHistory } from './calls.js'
import { readTraffic, readTrafficEntry, trafficClients, clearTraffic } from './traffic.js'
import { resolveDef } from './config.js'
import { isTestable, testConnection, TESTABLE_TYPES } from './conn-test.js'
import { browsableConnections } from './dbbrowser-api.js'
import type { BrowseEdit, BrowseFilter, ImportMapping } from './dbbrowser.js'

function object(raw: unknown): Record<string, unknown> {
  if (raw === undefined) return {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('parameters must be an object')
  return raw as Record<string, unknown>
}
const str = (v: unknown): string => typeof v === 'string' ? v : ''
const number = (v: unknown, max = 1000): number => Math.max(0, Math.min(max, Math.floor(Number(v)) || 0))
/**
 * Every method that takes an instance name must check it, so it is one
 * function rather than a line each of them can forget. `mcp.clearCalls` did
 * forget it, and that name reaches `rm(..., { recursive: true })` in calls.ts:
 * `url.pathname` keeps `%2F` intact, so a bridge request for `..%2F..%2Fx`
 * arrived here decoded as `../../x` and took that whole tree with it.
 */
function instanceName(v: unknown): string {
  const name = str(v)
  if (!/^[A-Za-z0-9_-]{1,63}$/.test(name)) throw new Error('invalid instance name')
  return name
}

export const ADMIN_METHODS: Record<string, IpcMethod> = {
  'mcp.resolveDefinition': async (_engine, raw) => {
    const p = object(raw)
    if (!p.def || typeof p.def !== 'object' || Array.isArray(p.def)) throw new Error('definition required')
    return { def: resolveDef(p.def as never) }
  },
  /**
   * Probe a DRAFT definition before it is saved anywhere. ${ENV} references
   * are resolved first, so the test exercises the same values the running MCP
   * would get. A reachable/unreachable answer is a 200 with ok:false — only an
   * untestable or malformed definition is an error.
   */
  'mcp.test': async (_engine, raw) => {
    const p = object(raw)
    if (!p.def || typeof p.def !== 'object' || Array.isArray(p.def)) throw new Error('definition required')
    const def = resolveDef(p.def as never)
    if (!isTestable(String(def.type ?? ''))) {
      return { testable: false, types: TESTABLE_TYPES as readonly string[] }
    }
    return { testable: true, ...(await testConnection(def)) }
  },
  'tokens.list': async (engine) => ({ tokens: engine.tokens.list() }),
  'tokens.create': async (engine, raw) => {
    const label = str(object(raw).label).trim()
    if (!label || label.length > 160) throw new Error('token label must be 1-160 characters')
    return engine.tokens.create(label)
  },
  'tokens.reveal': async (engine, raw) => {
    const token = engine.tokens.get(str(object(raw).id))
    if (!token) throw new Error('unknown token')
    return token
  },
  'tokens.rotate': async (engine, raw) => {
    const token = engine.tokens.rotate(str(object(raw).id))
    if (!token) throw new Error('unknown token')
    return token
  },
  'tokens.revoke': async (engine, raw) => ({ ok: engine.tokens.remove(str(object(raw).id)) }),
  'env.list': async () => {
    const names = Object.keys(readEnvStore()).sort()
    return { vars: names.map(name => ({ name })), entries: names.map(key => ({ key, masked: true })) }
  },
  'env.set': async (_engine, raw) => {
    const p = object(raw), key = str(p.name ?? p.key)
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,159}$/.test(key) || /^(DSH_|MCP_GATEWAY_|NODE_OPTIONS$|PATH$|HOME$|USERPROFILE$)/i.test(key)) throw new Error('invalid or reserved environment variable')
    if (p.value !== null && typeof p.value !== 'string') throw new Error('value must be string or explicit null')
    if (typeof p.value === 'string' && p.value.length > 65536) throw new Error('environment value too large')
    const store = readEnvStore()
    if (p.value === null) { delete store[key]; delete process.env[key] }
    else { store[key] = p.value as string; process.env[key] = p.value as string }
    writeEnvStore(store)
    return { saved: key, appliesTo: 'new snapshots' }
  },
  'mcp.calls': async (engine, raw) => {
    const p = object(raw), name = instanceName(p.name)
    const page = await readCalls(name, number(p.page, 10000), Math.max(1, number(p.pageSize ?? 20, 100)))
    const e = engine.registry.get(name)
    // `type` and `lifecycle` ride along because a BLANK stderr means three
    // different things — no child yet, a child that died silently, a child
    // running and quiet — and only the entry's kind and state tell them apart.
    // Sent here rather than fetched separately: the panel would otherwise
    // ensure() the entry just to caption an empty box.
    return { ...page, name, stderr: e?.adapter.logs?.() ?? '', type: e?.adapter.type, lifecycle: e?.lifecycle }
  },
  'mcp.callDetail': async (_engine, raw) => {
    const p = object(raw), name = instanceName(p.name)
    return { call: await readCall(name, number(p.seq, Number.MAX_SAFE_INTEGER)) }
  },
  /** Which logs belong to this entry: its own, plus one per session instance. */
  'mcp.callSources': async (_engine, raw) => {
    const name = instanceName(object(raw).name)
    return { sources: await listCallSources(name) }
  },
  'mcp.clearCalls': async (_engine, raw) => { await clearCalls(instanceName(object(raw).name)); return { ok: true } },
  /** Past calls of ONE tool, optionally filtered — "what did I pass last time?". */
  'mcp.toolHistory': async (_engine, raw) => {
    const p = object(raw), name = instanceName(p.name), tool = str(p.tool)
    if (tool === '') throw new Error('tool is required')
    const limit = number(p.limit ?? 0, 200)
    const q = str(p.q)
    return { tool, entries: await readToolHistory(name, tool, limit > 0 ? limit : undefined, q === '' ? undefined : q) }
  },
  'traffic.list': async (_engine, raw) => {
    const p = object(raw)
    const result = readTraffic({ mcp: str(p.mcp) || undefined, client: str(p.client) || undefined, method: str(p.method) || undefined, actionsOnly: p.actionsOnly === true, page: number(p.page, 10000), pageSize: Math.max(1, number(p.pageSize ?? 30, 100)) })
    return { ...result, rows: result.entries, clients: trafficClients() }
  },
  'traffic.detail': async (_engine, raw) => ({ entry: readTrafficEntry(number(object(raw).seq, Number.MAX_SAFE_INTEGER)) }),
  'traffic.clear': async (_engine, raw) => { clearTraffic(str(object(raw).client) || undefined); return { ok: true } },
  'data.connections': async (engine, raw) => {
    const p = object(raw)
    // registry-wide browsable rows (mysql/pg/mongo/redis), shaped like the
    // admin panel's Data picker: dialect/label/readonly/state/editable.
    const rows = browsableConnections(engine.registry)
    // An ABSENT `names` means "everything this engine can browse". A PRESENT
    // one is a SCOPE, and an empty scope means nothing -- never everything, or
    // a workspace whose db entries all failed to ensure would be handed every
    // other workspace's connections by the very call meant to scope them.
    if (!Array.isArray(p.names)) return { connections: rows }
    const filter = new Set(p.names.filter((x): x is string => typeof x === 'string'))
    return { connections: rows.filter(row => filter.has(row.name)) }
  },
  'data.operation': async (engine, raw, signal) => {
    const p = object(raw), name = str(p.name), op = str(p.op)
    signal.throwIfAborted()
    const entry = await engine.registry.ensureStarted(name)
    if (entry.lifecycle !== 'started') throw new Error('MCP not running')
    engine.registry.noteActivity(name)
    const db = entry.adapter.dbBrowser?.(), mongo = entry.adapter.mongoBrowser?.(), redis = entry.adapter.redisBrowser?.()
    const table = str(p.table), schema = str(p.schema) || undefined
    if (['edits', 'ddl', 'import', 'command'].includes(op) && p.confirm !== true) throw new Error('explicit confirmation required')
    if (db) {
      if (op === 'tables') return db.listTables({ grep: str(p.grep) || undefined, page: p.page, limit: p.limit })
      if (op === 'data') {
        const filters = p.filters === undefined ? undefined : typeof p.filters === 'string' ? JSON.parse(p.filters) : p.filters
        if (filters !== undefined && (!Array.isArray(filters) || filters.length > 16)) throw new Error('at most 16 filters allowed')
        return db.readTable({ table, schema, offset: p.offset, limit: p.limit, order: str(p.order) || undefined, dir: str(p.dir) || undefined, filters: filters as BrowseFilter[] | undefined })
      }
      if (op === 'schema') return db.describeTable({ table, schema })
      if (op === 'query') return db.runQuery(str(p.sql), p.limit)
      if (op === 'export') return db.exportTable({ table, schema, format: p.format === 'csv' ? 'csv' : 'json', limit: Math.min(number(p.limit ?? 1000, 10000), 10000) })
      if (op === 'edits') {
        if (!Array.isArray(p.edits) || p.edits.length > 500) throw new Error('edits must be an array of at most 500 rows')
        return db.applyEdits({ table, schema, edits: p.edits as BrowseEdit[] })
      }
      if (op === 'ddl') {
        if (!['rename', 'truncate', 'drop'].includes(str(p.action))) throw new Error('invalid DDL action')
        return db.ddlOp({ table, schema, op: p.action as 'rename' | 'truncate' | 'drop', to: str(p.to) || undefined })
      }
      if (op === 'import') {
        if (!Array.isArray(p.header) || !p.header.every(x => typeof x === 'string') || !Array.isArray(p.lines) || !p.lines.every(x => typeof x === 'string') || p.lines.length > 10000 || !Array.isArray(p.mapping) || p.mapping.length !== p.header.length || !p.mapping.every(x => x === null || typeof x === 'string')) throw new Error('invalid import shape')
        return db.importTable({ table, schema, header: p.header as string[], lines: p.lines as string[], mapping: p.mapping as ImportMapping })
      }
    }
    if (mongo) {
      if (op === 'collections') return { collections: await mongo.listCollections({ grep: str(p.grep) || undefined }) }
      if (op === 'docs') return mongo.readCollection({ collection: str(p.collection), filterJson: str(p.filter) || undefined, offset: p.offset, limit: p.limit })
    }
    if (redis) {
      if (op === 'keys') return redis.listKeys({ pattern: str(p.pattern) || undefined, cursor: str(p.cursor) || undefined, count: p.count, type: str(p.type) || undefined })
      if (op === 'key') return redis.readKey(str(p.key))
      if (op === 'command') return { reply: await redis.runCommand(str(p.command)) }
    }
    throw new Error('data operation not supported for this MCP')
  },
}
