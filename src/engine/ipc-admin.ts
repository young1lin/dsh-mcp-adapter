/** Explicit private-IPC management operations, not an HTTP proxy. */
import type { IpcMethod } from './ipc-service.js'
import { readCalls, readCall, clearCalls, listCallSources, readToolHistory } from './calls.js'
import { resolveDef } from './config.js'
import { isTestable, testConnection, TESTABLE_TYPES } from './conn-test.js'

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
}
