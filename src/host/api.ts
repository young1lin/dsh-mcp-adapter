/**
 * The same-origin bridge between the browser half and the host services
 * (config service + engine supervisor), TASK P5. Routes under
 * /dsh-mcp-manager are READ/WRITE management for the DSH UI only — the
 * engine's own loopback HTTP surface stays private, and this bridge is the
 * one management door.
 *
 * Trust fence (mirrors dsh-request-log's, which mirrors client-connection's
 * /api fence): the Host header must be loopback (or a trusted authority),
 * browser markers (Origin, Sec-Fetch-Site) must be same-origin, and a
 * loopback-named Host is honored only when the connection itself is
 * loopback. DNS rebinding cannot forge Host; a non-browser client on a
 * non-loopback bind cannot forge the socket's remote address.
 *
 * @module dsh-mcp-adapter/host/api
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ConfigService } from '../config/service.js'
import type { EngineSupervisor } from '../runtime/engine-supervisor.js'

/** The route prefix this plugin owns (NOT under /api — that is the harness RPC carrier). */
export const API_PREFIX = '/dsh-mcp-manager'

/** Minimal typing of the webServer service face this plugin consumes. */
export interface WebServerFace {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** Everything the bridge needs. */
import { portFree, readListener, resolveListener, writeListener, type ListenerConfig, type ListenerState } from './listener.js'

export interface BridgeDeps {
  config: ConfigService
  engine: () => EngineSupervisor | undefined
  /** Plugin storage root (migration target). */
  storageDir: string
  /**
   * The plugin config's own say on the MCP endpoint, when it has one. Read
   * through a function because the config is re-resolved on reload, and a
   * stale snapshot would tell the panel it owns a switch the config has since
   * taken over. Absent means nothing in the config fixes it.
   */
  listenerConfig?: () => ListenerConfig | undefined
  /**
   * What the supervisor actually did with it at load time — including the
   * `problem` when the chosen port was taken. The intent and the outcome are
   * different facts, and the panel has to show the one the user is living with.
   */
  listenerActual?: () => (ListenerState & { problem?: string }) | undefined
  /** Global standard file path (backup export); defaults to ~/.agents/.mcp.json. */
  globalFile?: string
  workspaces?: () => Array<{ id: string; path: string; title?: string }>
}

/** Non-loopback authorities this deployment trusts (LAN IPs, hostnames). */
export interface BridgeOptions {
  trustedHosts?: readonly string[]
}

interface Wire extends IncomingMessage {
  url: string
  query: URLSearchParams
  body?: unknown
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  if (!hostname.startsWith('127.')) return false
  const parts = hostname.split('.')
  return parts.length === 4 && parts.every((p) => /^\d+$/.test(p) && Number(p) <= 255)
}

function hostOf(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const s = value.trim()
  if (s.startsWith('[')) {
    const end = s.indexOf(']')
    return end < 0 ? s : s.slice(0, end + 1)
  }
  if (s.split(':').length > 2) return s
  const i = s.indexOf(':')
  return i < 0 ? s : s.slice(0, i)
}

function trustedAuthority(host: string, trusted: readonly string[]): boolean {
  for (const entry of trusted) {
    if (entry === host) return true
    if (!entry.includes(':') && hostOf(host) === entry) return true
  }
  return false
}

function remoteIsLoopback(req: IncomingMessage): boolean {
  const addr = req.socket?.remoteAddress ?? ''
  const s = addr.startsWith('::ffff:') ? addr.slice(7) : addr
  return isLoopbackHostname(s) || s === '::1'
}

/** The fence: undefined lets the request through; a string is the refusal. */
export function refusalFor(req: IncomingMessage, options: BridgeOptions): string | undefined {
  const host = req.headers.host
  if (host === undefined) return 'no Host header'
  const hostname = hostOf(host)!
  const loopbackNamed = isLoopbackHostname(hostname)
  if (!loopbackNamed && !trustedAuthority(host, options.trustedHosts ?? [])) {
    return 'Host must name this machine'
  }
  if (loopbackNamed && !remoteIsLoopback(req) && !trustedAuthority(host, options.trustedHosts ?? [])) {
    return 'loopback Host from a non-loopback peer'
  }
  const origin = req.headers.origin
  if (origin !== undefined) {
    try {
      if (!isLoopbackHostname(new URL(origin).hostname)) return 'cross-origin Origin'
    } catch {
      return 'malformed Origin'
    }
  }
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'same-site' && site !== 'none') {
    return 'cross-site fetch marker'
  }
  return undefined
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 2 * 1024 * 1024) {
        reject(new Error('body over 2MB'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve(undefined)
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(new Error('invalid JSON body: ' + String((error as Error).message)))
      }
    })
    req.on('error', reject)
  })
}

/**
 * Mount the bridge. Returns the disposer.
 * @param web - the webServer service face.
 * @param deps - config service + engine accessor.
 * @param options - trust options.
 */
export function mountBridge(web: WebServerFace, deps: BridgeDeps, options: BridgeOptions = {}): () => void {
  return web.register({ kind: 'prefix', path: API_PREFIX, handler: (req, res) => void dispatch(req as Wire, res, deps, options) })
}

async function dispatch(req: Wire, res: ServerResponse, deps: BridgeDeps, options: BridgeOptions): Promise<void> {
  const refusal = refusalFor(req, options)
  if (refusal !== undefined) return sendJson(res, 403, { error: refusal })
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  req.query = url.searchParams
  const path = url.pathname.slice(API_PREFIX.length)
  try {
    if (req.method === 'POST' || req.method === 'PUT') req.body = await readBody(req)
    const result = await route(req, path, deps)
    sendJson(res, 200, result ?? { ok: true })
  } catch (error) {
    const code = (error as { code?: string }).code
    const status = code === 'CONFLICT' ? 409 : code === 'INVALID' || code === 'SCOPE' || code === 'NOT_FOUND' ? 400 : 500
    sendJson(res, status, { error: (error as Error).message, ...(code !== undefined ? { code } : {}) })
  }
}

/**
 * The name->definition map inside a pasted document. Native catalogs are
 * posted either bare or wrapped ({servers}/{mcpServers}), and every client
 * that exports one picks a different wrapper, so accept all three.
 */
function serverMapOf(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const doc = raw as Record<string, unknown>
  for (const key of ['servers', 'mcpServers']) {
    const nested = doc[key]
    if (nested !== null && typeof nested === 'object' && !Array.isArray(nested)) return nested as Record<string, unknown>
  }
  return doc
}

async function route(req: Wire, path: string, deps: BridgeDeps): Promise<unknown> {
  const method = (req.method ?? 'GET').toUpperCase()
  const body = (req.body ?? {}) as Record<string, unknown>
  const ws = typeof req.query.get('ws') === 'string' && req.query.get('ws') !== '' ? req.query.get('ws')! : undefined
  const ss = typeof req.query.get('ss') === 'string' && req.query.get('ss') !== '' ? req.query.get('ss')! : undefined

  // --- configuration plane ---
  if (method === 'GET' && path === '/workspaces') return { items: deps.workspaces?.() ?? [] }
  if (method === 'GET' && path === '/preview') {
    return deps.config.preview({ ...(ws !== undefined ? { workspaceId: ws } : {}), ...(ss !== undefined ? { sessionId: ss } : {}) })
  }
  if (method === 'POST' && (path === '/entry' || path === '/enabled')) {
    const base = { ...(ws !== undefined ? { workspaceId: ws } : {}), ...(ss !== undefined ? { sessionId: ss } : {}) }
    if (path === '/entry') {
      return deps.config.saveEntry({
        level: String(body.level) as 'global' | 'project' | 'session',
        source: String(body.source) as 'standard' | 'native' | 'session',
        name: String(body.name ?? ''),
        def: (body.def ?? null) as never,
        expectedRevision: String(body.expectedRevision ?? ''),
        ...(typeof body.layerId === 'string' ? { layerId: body.layerId } : {}),
        ...base,
      })
    }
    return deps.config.setEnabled({
      level: String(body.level) as 'global' | 'project' | 'session',
      name: String(body.name ?? ''),
      enabled: body.enabled === true,
      expectedRevision: String(body.expectedRevision ?? ''),
        ...(typeof body.layerId === 'string' ? { layerId: body.layerId } : {}),
      ...base,
    })
  }

  // --- view metadata (grouping + manual order) ---
  // Panel presentation only: never written into a config layer, so it applies
  // uniformly to entries that live on different layers and keeps dsh-only
  // keys out of the .mcp.json files other MCP clients also read.
  if (path === '/view' && (method === 'GET' || method === 'POST')) {
    const { readViewMeta, writeViewMeta, groupsOf, moveEntry, MAX_GROUP_LENGTH } = await import('../config/view-meta.js')
    const base = { ...(ws !== undefined ? { workspaceId: ws } : {}), ...(ss !== undefined ? { sessionId: ss } : {}) }
    const meta = await readViewMeta(deps.storageDir)
    if (method === 'GET') return { ...meta, groups: groupsOf(meta.entries) }
    const preview = await deps.config.preview(base)
    const known = new Set(preview.entries.map((e) => e.name))
    const name = String(body.name ?? '')
    if (!known.has(name)) throw Object.assign(new Error('unknown entry: ' + name), { code: 'NOT_FOUND' })
    let next = meta
    if (body.move === 'up' || body.move === 'down') {
      next = { version: 1, entries: moveEntry(preview.entries, meta.entries, name, body.move === 'up' ? -1 : 1) }
    } else {
      // group: a string files it, null/'' takes it out of every group.
      const raw = body.group
      if (raw !== null && typeof raw !== 'string') throw Object.assign(new Error('group must be a string or null'), { code: 'INVALID' })
      const group = typeof raw === 'string' ? raw.trim().slice(0, MAX_GROUP_LENGTH) : ''
      const view = { ...meta.entries[name] }
      if (group === '') delete view.group
      else view.group = group
      // Moving buckets drops the old bucket's order: it meant nothing there.
      delete view.order
      next = { version: 1, entries: { ...meta.entries, [name]: view } }
    }
    // Written WITHOUT pruning to `known`: ui-view.json is one plugin-wide
    // file, while `known` is only the entries visible in the scope being
    // served, so pruning to it erased every grouping the user had made while
    // another workspace was selected. `known` still gates which entry may be
    // TOUCHED (above) — that part was always right.
    const saved = writeViewMeta(deps.storageDir, next)
    return { ...saved, groups: groupsOf(saved.entries) }
  }

  // --- rename an entry on its own layer ---
  // Two writes on one layer: create the new name, then drop the old one. The
  // pair is NOT atomic (each save is, the sequence is not), so a failure to
  // remove the old name reports that the new one already exists rather than
  // pretending the rename did not happen.
  if (method === 'POST' && path === '/rename') {
    const base = { ...(ws !== undefined ? { workspaceId: ws } : {}), ...(ss !== undefined ? { sessionId: ss } : {}) }
    const from = String(body.from ?? '')
    const to = String(body.to ?? '')
    if (from === '' || to === '') throw Object.assign(new Error('from and to are required'), { code: 'INVALID' })
    if (from === to) throw Object.assign(new Error('the name is unchanged'), { code: 'INVALID' })
    // Anything hosted by the engine must satisfy this, so refuse it up front
    // rather than saving a name that can never start.
    if (!/^[A-Za-z0-9_-]{1,63}$/.test(to)) {
      throw Object.assign(new Error('a name must be 1-63 characters of A-Z a-z 0-9 _ -'), { code: 'INVALID' })
    }
    // A rename is a create followed by a delete, and `null` is saveEntry's
    // DELETE sentinel — so a request that omits `def` used to remove `from` and
    // create nothing. The panel always sends it; a hand-built request is the
    // only way in, which is exactly why it is refused rather than defaulted.
    if (body.def === null || typeof body.def !== 'object' || Array.isArray(body.def)) {
      throw Object.assign(new Error('def is required to rename'), { code: 'INVALID' })
    }
    const layerId = String(body.layerId ?? '')
    const preview = await deps.config.preview(base)
    if (preview.entries.some((e) => e.name === to)) {
      throw Object.assign(new Error('that name is already taken: ' + to), { code: 'INVALID' })
    }
    const layer = preview.layers.find((l) => (l.layerId ?? l.level + ':' + l.source) === layerId)
    if (layer === undefined) throw Object.assign(new Error('unknown layer: ' + layerId), { code: 'NOT_FOUND' })
    const addr = {
      level: layer.level as 'global' | 'project' | 'session',
      source: layer.source as 'standard' | 'native' | 'session',
      layerId, ...base,
    }
    const written = await deps.config.saveEntry({
      ...addr, name: to, def: body.def as never, expectedRevision: String(body.expectedRevision ?? ''),
    })
    try {
      const removed = await deps.config.saveEntry({ ...addr, name: from, def: null as never, expectedRevision: written.revision })
      // Carry the panel's grouping/order across, or a rename would silently
      // dump the entry back into the ungrouped bucket.
      const { readViewMeta, writeViewMeta } = await import('../config/view-meta.js')
      const meta = await readViewMeta(deps.storageDir)
      const carried = meta.entries[from]
      if (carried !== undefined) {
        const entries = { ...meta.entries, [to]: carried }
        delete entries[from]
        writeViewMeta(deps.storageDir, { version: 1, entries })
      }
      return { from, to, revision: removed.revision }
    } catch (error) {
      throw Object.assign(
        new Error('created ' + to + ' but could not remove ' + from + ': ' + (error as Error).message),
        { code: 'INVALID' },
      )
    }
  }

  // --- bulk import: paste a .mcp.json (or a native catalog) into ONE layer ---
  // planStandardImport/planNativeImport have existed (and been unit-tested)
  // since the config service landed; this is the route that finally reaches
  // them, so "add MCP" is no longer one-JSON-blob-at-a-time. Planning is a
  // dry run: nothing is written until the caller posts apply:true.
  if (method === 'POST' && path === '/import') {
    const base = { ...(ws !== undefined ? { workspaceId: ws } : {}), ...(ss !== undefined ? { sessionId: ss } : {}) }
    const layerId = String(body.layerId ?? '')
    const preview = await deps.config.preview(base)
    const layer = preview.layers.find((l) => (l.layerId ?? l.level + ':' + l.source) === layerId)
    if (layer === undefined) throw Object.assign(new Error('unknown layer: ' + layerId), { code: 'NOT_FOUND' })
    let parsed: unknown
    try { parsed = JSON.parse(String(body.text ?? '')) } catch (error) {
      throw Object.assign(new Error('not valid JSON: ' + (error as Error).message), { code: 'INVALID' })
    }
    const { planStandardImport, planNativeImport } = await import('../config/transfer.js')
    // Every name already visible in the scope is "taken": allocating around
    // them keeps an import from silently shadowing an entry on a lower layer.
    const taken = new Set(preview.entries.map((e) => e.name))
    const plan = layer.source === 'native'
      ? planNativeImport(serverMapOf(parsed), taken)
      : planStandardImport(parsed, taken)
    if (body.apply !== true) return { layerId, add: plan.add, skip: plan.skip }
    // One save per entry, chaining the revision the previous save returned —
    // a mid-import failure therefore reports exactly what did land.
    const added: string[] = []
    const failed: Array<{ name: string; error: string }> = []
    let revision = layer.revision
    for (const row of plan.add) {
      try {
        const out = await deps.config.saveEntry({
          level: layer.level as 'global' | 'project' | 'session',
          source: layer.source as 'standard' | 'native' | 'session',
          layerId, name: row.name, def: row.def as never, expectedRevision: revision, ...base,
        })
        revision = out.revision
        added.push(row.name)
      } catch (error) { failed.push({ name: row.name, error: (error as Error).message }) }
    }
    return { layerId, added, failed, skip: plan.skip, revision }
  }

  // --- session view (P5.8): the read-only session file (overrides revision + snapshot) ---
  if (method === 'GET' && path === '/session') {
    if (ss === undefined) throw Object.assign(new Error('ss is required'), { code: 'SCOPE' })
    const { readSessionFile, sessionFilePath, revisionOfSession, isRestorableSnapshot } = await import('../config/session-store.js')
    const { publicNameLite } = await import('../session.js')
    const { file } = await readSessionFile(sessionFilePath(deps.storageDir, ss))
    const snap = file.snapshot
    let snapshot: { revision: string; registeredAt: string; tools: string[] } | undefined
    if (isRestorableSnapshot(snap)) {
      snapshot = {
        revision: snap.configRevision,
        registeredAt: snap.registeredAt,
        tools: snap.servers.flatMap((server) => server.tools.map((tool) => publicNameLite(server.logical, tool.name))),
      }
    } else if (snap !== undefined && Array.isArray((snap as { tools?: unknown }).tools)) {
      const legacy = snap as { revision?: string; registeredAt?: string; tools: string[] }
      snapshot = { revision: legacy.revision ?? '', registeredAt: legacy.registeredAt ?? '', tools: legacy.tools }
    }
    return { sessionId: ss, revision: revisionOfSession(file), ...(snapshot !== undefined ? { snapshot } : {}) }
  }

  // --- engine plane ---
  const engine = deps.engine()
  if (method === 'GET' && path === '/engine') {
    if (engine === undefined) return { off: true }
    return engine.request('engine.status', undefined, { timeoutMs: 30000 })
  }
  // --- the MCP endpoint: one master switch and one port ---
  // Answered with the engine down on purpose: "it is off" is exactly when
  // someone comes here to turn it on.
  if (method === 'GET' && path === '/listener') {
    const stored = readListener(deps.storageDir)
    const state = resolveListener(deps.listenerConfig?.(), stored)
    const actual = deps.listenerActual?.()
    return {
      ...state,
      ...(stored !== undefined ? { stored } : {}),
      // The intent is what the switch shows; `active` and `problem` are what
      // the user is actually living with, which is not always the same thing.
      ...(actual !== undefined ? { active: actual.enabled, activePort: actual.port } : {}),
      ...(actual?.problem !== undefined ? { problem: actual.problem } : {}),
    }
  }
  if (method === 'POST' && path === '/listener') {
    const state = resolveListener(deps.listenerConfig?.(), readListener(deps.storageDir))
    // A config file outranks a click. Refusing loudly beats writing a setting
    // that would never be read.
    if (state.locked) throw new Error('the MCP endpoint is fixed by the plugin config (engine.publicMcp / engine.httpPort)')
    const body = (req.body ?? {}) as { enabled?: unknown; port?: unknown }
    const saved = writeListener(deps.storageDir, { enabled: body.enabled, port: body.port })
    // Say it at the click, not at the next restart. The port is only checked,
    // never claimed here — this is a warning about what the engine will meet,
    // and the user may be about to free it.
    const actual = deps.listenerActual?.()
    const ours = actual?.enabled === true && actual.port === saved.port
    const busy = saved.enabled && !ours && !(await portFree(saved.port))
    // Applied by the supervisor at the next apply, not here: rebinding a live
    // listener from inside the request that asked for it is not something to do.
    return { ...saved, locked: false, restartRequired: true, ...(busy ? { problem: 'port ' + String(saved.port) + ' is already in use' } : {}) }
  }

  if (engine === undefined) throw new Error('engine is not enabled')
  if (method === 'GET' && path === '/memory') {
    return engine.request('engine.memory', { tree: req.query.get('tree') === '1' }, { timeoutMs: 60000 })
  }

  // Probe a DRAFT definition. Name-less on purpose: nothing is saved or
  // hosted, so this is the one MCP route that does not address an entry.
  // Checked BEFORE the /mcp/:name/:action match, which needs three segments.
  if (method === 'POST' && path === '/mcp/test') {
    if (body.def === null || typeof body.def !== 'object') throw Object.assign(new Error('def is required'), { code: 'INVALID' })
    return engine.request('mcp.test', { def: body.def }, { timeoutMs: 30000 })
  }

  // one full call record (3 segments — checked before the generic 2-segment match)
  const callMatch = /^\/mcp\/([^/]+)\/calls\/(\d+)$/.exec(path)
  if (callMatch !== null && method === 'GET') {
    return engine.request('mcp.callDetail', { name: decodeURIComponent(callMatch[1]!), seq: Number(callMatch[2]) }, { timeoutMs: 30000 })
  }

  // [\w-] , not \w: a hyphen is ordinary in a path segment, and `\w+` silently
  // turned /mcp/:name/call-sources into "no route" rather than a 404 anyone
  // would read as one.
  const mcpMatch = /^\/mcp\/([^/]+)\/([\w-]+)$/.exec(path)
  if (mcpMatch !== null) {
    const name = decodeURIComponent(mcpMatch[1]!)
    const action = mcpMatch[2]!
    if (method === 'GET') {
      const cursor = req.query.get('cursor') ?? undefined
      if (action === 'calls') {
        return engine.request('mcp.calls', { name, page: Math.max(0, Number(req.query.get('page') ?? 0) || 0) }, { timeoutMs: 30000 })
      }
      if (action === 'tools') return engine.request('mcp.tools', { name, cursor }, { timeoutMs: 60000 })
      if (action === 'resources') return engine.request('mcp.resources', { name, cursor }, { timeoutMs: 60000 })
      if (action === 'prompts') return engine.request('mcp.prompts', { name, cursor }, { timeoutMs: 60000 })
      if (action === 'status') return engine.request('mcp.status', { name }, { timeoutMs: 30000 })
      // Read ONE resource's content. The engine has answered mcp.resourceRead
      // since the IPC table landed; nothing ever asked it, so the Resources
      // tab could list a resource but never open it.
      // Which logs this entry has: its own, plus one per session instance a
      // DSH agent's calls were recorded under.
      if (action === 'call-sources') return engine.request('mcp.callSources', { name }, { timeoutMs: 30000 })
      // Past calls of ONE tool — what the Run tab replays arguments from.
      if (action === 'history') {
        const tool = req.query.get('tool') ?? ''
        if (tool === '') throw Object.assign(new Error('tool is required'), { code: 'INVALID' })
        return engine.request('mcp.toolHistory', {
          name, tool,
          limit: Number(req.query.get('limit') ?? 20) || 20,
          ...(req.query.get('q') !== null && req.query.get('q') !== '' ? { q: req.query.get('q') } : {}),
        }, { timeoutMs: 30000 })
      }
      if (action === 'resource') {
        const uri = req.query.get('uri') ?? ''
        if (uri === '') throw Object.assign(new Error('uri is required'), { code: 'INVALID' })
        return engine.request('mcp.resourceRead', { name, uri }, { timeoutMs: 60000 })
      }
    } else if (method === 'DELETE') {
      if (action === 'calls') return engine.request('mcp.clearCalls', { name }, { timeoutMs: 30000 })
    } else if (method === 'POST') {
      if (action === 'ensure') {
        // Detail-on-demand: resolve the entry from the merged config (REAL
        // secrets — host-internal), convert standard->native, and host it on
        // the private engine so status/tools/resources/run all answer.
        const preview = await deps.config.preview({
          ...(ws !== undefined ? { workspaceId: ws } : {}),
          ...(ss !== undefined ? { sessionId: ss } : {}),
          maskSecrets: false,
        })
        const entry = preview.entries.find((e) => e.name === name)
        if (entry === undefined) throw new Error('unknown MCP in config: ' + name)
        if (entry.disabled) throw new Error('MCP is disabled: ' + name)
        let def = entry.def as Record<string, unknown>
        if (entry.source === 'standard') {
          const { standardToNative } = await import('../config/transfer.js')
          const converted = standardToNative(def)
          if (converted === undefined) throw new Error('standard entry has no engine carrier: ' + name)
          def = converted as Record<string, unknown>
        }
        return engine.request('mcp.ensure', { name, def, start: true }, { timeoutMs: 120000 })
      }
      if (action === 'call') {
        return engine.request('mcp.call', { name, tool: String(body.tool ?? ''), arguments: body.arguments ?? {}, source: 'panel', timeoutMs: 120000 }, { timeoutMs: 150000 })
      }
      if (action === 'start' || action === 'stop' || action === 'restart') {
        return engine.request('mcp.' + action, { name }, { timeoutMs: 120000 })
      }
      if (action === 'setToolEnabled') {
        return engine.request('mcp.setToolEnabled', { name, tool: String(body.tool ?? ''), enabled: body.enabled === true }, { timeoutMs: 30000 })
      }
      if (action === 'setResourcesEnabled') {
        return engine.request('mcp.setResourcesEnabled', { name, enabled: body.enabled === true }, { timeoutMs: 30000 })
      }
    }
  }

  // --- advanced plane (P5.6/P6): token reveal, migration plan/apply ---
  if (method === 'POST' && path === '/skill/install') {
    // lmg skill install 的 DSH 等效入口（P6.9）：同包引擎源码、宿主进程执行，
    // 目标仍是 ~/.agents|~/.claude|~/.cursor 三个用户级 skill 目录（幂等替换）。
    const { installSkill } = await import('../engine/skill-install.js')
    return { installed: installSkill() }
  }
  if (method === 'GET' && path === '/creds') {
    // lmg creds 等效：默认令牌 + 引擎 origin（供外部客户端配置）。
    if (engine === undefined) throw new Error('engine is not enabled')
    const bearer = await engine.request('engine.bearer', undefined, { timeoutMs: 30000 }) as { secret?: string }
    const status = await engine.request('engine.status', undefined, { timeoutMs: 30000 }) as { port?: number }
    return { url: 'http://127.0.0.1:' + String(status.port ?? 0), token: bearer.secret ?? '' }
  }
  if (method === 'GET' && path === '/token/default') {
    // EXPLICIT reveal (the user pressed the button); same policy as the
    // engine's /api/tokens/:id/secret — an explicit act, never list payload.
    return engine.request('engine.bearer', undefined, { timeoutMs: 30000 })
  }
  if (method === 'GET' && path === '/migration/plan') {
    const dir = String(req.query.get('dir') ?? '')
    if (dir.length === 0) throw new Error('dir is required')
    const { statSync } = await import('node:fs')
    if (!statSync(dir).isDirectory()) throw new Error('dir is not a directory: ' + dir)
    const { planMigration } = await import('../config/legacy-import.js')
    return await planMigration(dir, deps.storageDir)
  }
  if (method === 'POST' && path === '/migration/apply') {
    const dir = String(body.dir ?? '')
    if (dir.length === 0) throw new Error('dir is required')
    const { planMigration, applyMigration } = await import('../config/legacy-import.js')
    const plan = await planMigration(dir, deps.storageDir)
    return await applyMigration(plan, deps.storageDir)
  }

  // --- traffic plane (engine request-log; the Traffic page) ---
  if (method === 'GET' && path === '/traffic') {
    return engine.request('traffic.list', {
      mcp: req.query.get('mcp') ?? '',
      client: req.query.get('client') ?? '',
      method: req.query.get('method') ?? '',
      actionsOnly: req.query.get('actions') === '1',
      page: Math.max(0, Number(req.query.get('page') ?? 0) || 0),
      pageSize: Math.max(0, Number(req.query.get('pageSize') ?? 0) || 0),
    }, { timeoutMs: 30000 })
  }
  const trafficEntryMatch = /^\/traffic\/(\d+)$/.exec(path)
  if (trafficEntryMatch !== null && method === 'GET') {
    return engine.request('traffic.detail', { seq: Number(trafficEntryMatch[1]) }, { timeoutMs: 30000 })
  }
  if (method === 'DELETE' && path === '/traffic') {
    return engine.request('traffic.clear', { client: req.query.get('client') ?? '' }, { timeoutMs: 30000 })
  }

  // --- data plane (the Data page; ensure-on-demand over db-capable native entries) ---
  if (method === 'GET' && path === '/data') {
    const preview = await deps.config.preview({
      ...(ws !== undefined ? { workspaceId: ws } : {}),
      ...(ss !== undefined ? { sessionId: ss } : {}),
      maskSecrets: false,
    })
    const names: string[] = []
    for (const entry of preview.entries) {
      if (entry.disabled || entry.source !== 'native') continue
      const type = (entry.def as { type?: unknown }).type
      if (typeof type !== 'string' || !['mysql', 'pg', 'mongo', 'redis'].includes(type)) continue
      try {
        // Address the name the ENGINE answered, never the one we sent. An
        // identical definition that is already hosted — a session's instance,
        // say — comes back under ITS name, because mcp.ensure matches on the
        // definition hash rather than the name. data.connections filters by
        // name, so pushing ours hid a database that was running right then.
        const ensured = await engine.request(
          'mcp.ensure', { name: entry.name, def: entry.def, start: true }, { timeoutMs: 120000 },
        ) as { name?: unknown }
        names.push(typeof ensured?.name === 'string' && ensured.name !== '' ? ensured.name : entry.name)
      } catch { /* unreachable now: the connection is omitted from the browsable list */ }
    }
    return engine.request('data.connections', { names }, { timeoutMs: 30000 })
  }
  const dataTablesMatch = /^\/data\/([^/]+)\/tables$/.exec(path)
  if (dataTablesMatch !== null && method === 'GET') {
    const out = await engine.request('data.operation', {
      name: decodeURIComponent(dataTablesMatch[1]!),
      op: 'tables',
      grep: req.query.get('grep') ?? '',
      page: req.query.get('page') ?? '0',
    }, { timeoutMs: 60000 }) as { tables?: Array<{ name?: string; approxRows?: number | null }>; total?: number; page?: number }
    return {
      tables: (out.tables ?? []).map((t) => ({ name: String(t.name ?? ''), ...(typeof t.approxRows === 'number' ? { rows: t.approxRows } : {}) })),
      total: out.total ?? 0,
      page: out.page ?? 0,
    }
  }
  const dataReadMatch = /^\/data\/([^/]+)\/data$/.exec(path)
  if (dataReadMatch !== null && method === 'GET') {
    const out = await engine.request('data.operation', {
      name: decodeURIComponent(dataReadMatch[1]!),
      op: 'data',
      table: req.query.get('table') ?? '',
      offset: req.query.get('offset') ?? '0',
      limit: req.query.get('limit') ?? '50',
      // readTable has always accepted these; not forwarding them is what made
      // the grid a fixed, unsortable, unfilterable window onto the table.
      ...(req.query.get('order') !== null ? { order: req.query.get('order') } : {}),
      ...(req.query.get('dir') !== null ? { dir: req.query.get('dir') } : {}),
      ...(req.query.get('filters') !== null ? { filters: req.query.get('filters') } : {}),
    }, { timeoutMs: 120000 }) as Record<string, unknown>
    const columns = ((out.columns as Array<{ name?: string; dataType?: string }> | undefined) ?? [])
      .map((c) => ({ name: String(c.name ?? ''), ...(c.dataType !== undefined ? { type: c.dataType } : {}) }))
    return { ...out, columns, ...(typeof out.editNote === 'string' ? { reason: out.editNote } : {}) }
  }
  // The engine's data.operation answers thirteen ops; for a long time this
  // bridge forwarded three, so `schema`/`export` were unreachable on SQL
  // connections and redis/mongo had NO reachable operation at all — they
  // still appeared in the picker (browsableConnections lists them), so every
  // click on one failed. The rest of the read surface is wired below; the
  // WRITE ops (edits/ddl/import) stay unexposed until they have a
  // confirmation flow of their own.
  const dataOp = (op: string) => {
    const m = new RegExp('^/data/([^/]+)/' + op + '$').exec(path)
    return m === null ? undefined : decodeURIComponent(m[1]!)
  }
  const dataSchemaName = dataOp('schema')
  if (dataSchemaName !== undefined && method === 'GET') {
    return engine.request('data.operation', {
      name: dataSchemaName, op: 'schema',
      table: req.query.get('table') ?? '',
      ...(req.query.get('schema') !== null ? { schema: req.query.get('schema') } : {}),
    }, { timeoutMs: 60000 })
  }
  const dataExportName = dataOp('export')
  if (dataExportName !== undefined && method === 'GET') {
    return engine.request('data.operation', {
      name: dataExportName, op: 'export',
      table: req.query.get('table') ?? '',
      format: req.query.get('format') === 'json' ? 'json' : 'csv',
      limit: req.query.get('limit') ?? '1000',
    }, { timeoutMs: 120000 })
  }
  // --- redis ---
  const redisKeysName = dataOp('keys')
  if (redisKeysName !== undefined && method === 'GET') {
    return engine.request('data.operation', {
      name: redisKeysName, op: 'keys',
      pattern: req.query.get('pattern') ?? '',
      cursor: req.query.get('cursor') ?? '',
      count: req.query.get('count') ?? '100',
      type: req.query.get('type') ?? '',
    }, { timeoutMs: 60000 })
  }
  const redisKeyName = dataOp('key')
  if (redisKeyName !== undefined && method === 'GET') {
    return engine.request('data.operation', { name: redisKeyName, op: 'key', key: req.query.get('key') ?? '' }, { timeoutMs: 60000 })
  }
  const redisCommandName = dataOp('command')
  if (redisCommandName !== undefined && method === 'POST') {
    // The engine gates `command` behind an explicit confirmation. The console
    // forwards the user's own Run as that confirmation; the bridge never
    // supplies it on the caller's behalf.
    return engine.request('data.operation', {
      name: redisCommandName, op: 'command',
      command: String(body.command ?? ''),
      confirm: body.confirm === true,
    }, { timeoutMs: 60000 })
  }
  // --- mongo ---
  const mongoCollectionsName = dataOp('collections')
  if (mongoCollectionsName !== undefined && method === 'GET') {
    return engine.request('data.operation', { name: mongoCollectionsName, op: 'collections', grep: req.query.get('grep') ?? '' }, { timeoutMs: 60000 })
  }
  const mongoDocsName = dataOp('docs')
  if (mongoDocsName !== undefined && method === 'GET') {
    return engine.request('data.operation', {
      name: mongoDocsName, op: 'docs',
      collection: req.query.get('collection') ?? '',
      filter: req.query.get('filter') ?? '',
      offset: req.query.get('offset') ?? '0',
      limit: req.query.get('limit') ?? '50',
    }, { timeoutMs: 120000 })
  }
  const dataQueryMatch = /^\/data\/([^/]+)\/query$/.exec(path)
  if (dataQueryMatch !== null && method === 'POST') {
    const limit = Math.max(1, Math.min(1000, Number(body.limit ?? 100) || 100))
    const out = await engine.request('data.operation', {
      name: decodeURIComponent(dataQueryMatch[1]!),
      op: 'query',
      sql: String(body.sql ?? ''),
      limit,
    }, { timeoutMs: 120000 }) as { columns?: string[]; rows?: Array<Record<string, unknown>>; rowCount?: number }
    return {
      columns: (out.columns ?? []).map((name) => ({ name })),
      rows: out.rows ?? [],
      truncated: (out.rowCount ?? 0) >= limit,
    }
  }

  // --- tokens plane (named bearers; every secret read is an explicit action) ---
  if (method === 'GET' && path === '/tokens') {
    const out = await engine.request('tokens.list', undefined, { timeoutMs: 30000 }) as { tokens?: unknown[] }
    return { tokens: out.tokens ?? [], tokenEnv: 'MCP_GATEWAY_TOKEN' }
  }
  if (method === 'POST' && path === '/tokens') {
    return engine.request('tokens.create', { label: String(body.label ?? '') }, { timeoutMs: 30000 })
  }
  const tokenSecretMatch = /^\/tokens\/([^/]+)\/secret$/.exec(path)
  if (tokenSecretMatch !== null && method === 'GET') {
    return engine.request('tokens.reveal', { id: decodeURIComponent(tokenSecretMatch[1]!) }, { timeoutMs: 30000 })
  }
  const tokenRotateMatch = /^\/tokens\/([^/]+)\/rotate$/.exec(path)
  if (tokenRotateMatch !== null && method === 'POST') {
    return engine.request('tokens.rotate', { id: decodeURIComponent(tokenRotateMatch[1]!) }, { timeoutMs: 30000 })
  }
  const tokenDeleteMatch = /^\/tokens\/([^/]+)$/.exec(path)
  if (tokenDeleteMatch !== null && method === 'DELETE') {
    return engine.request('tokens.revoke', { id: decodeURIComponent(tokenDeleteMatch[1]!) }, { timeoutMs: 30000 })
  }

  // --- env plane (sealed store; values never leave the engine) ---
  if (method === 'GET' && path === '/env') {
    return engine.request('env.list', undefined, { timeoutMs: 30000 })
  }
  if (method === 'POST' && path === '/env') {
    return engine.request('env.set', { name: String(body.name ?? ''), value: body.value === null ? null : String(body.value ?? '') }, { timeoutMs: 30000 })
  }
  const envDeleteMatch = /^\/env\/([^/]+)$/.exec(path)
  if (envDeleteMatch !== null && method === 'DELETE') {
    return engine.request('env.set', { name: decodeURIComponent(envDeleteMatch[1]!), value: null }, { timeoutMs: 30000 })
  }

  // --- backup plane (export every layer; restore is explicit + mode-separated) ---
  const wsRefs = () => (deps.workspaces?.() ?? []).map((w) => ({ id: w.id, root: w.path }))
  if (method === 'GET' && path === '/backup/export') {
    const { exportBackup } = await import('./backup.js')
    return exportBackup({ storageDir: deps.storageDir, ...(deps.globalFile !== undefined ? { globalFile: deps.globalFile } : {}), workspaces: wsRefs() })
  }
  if (method === 'POST' && path === '/backup/restore') {
    const { restoreBackup } = await import('./backup.js')
    return restoreBackup({ storageDir: deps.storageDir, ...(deps.globalFile !== undefined ? { globalFile: deps.globalFile } : {}), workspaces: wsRefs() }, body.payload, body.mode === 'replace' ? 'replace' : 'merge')
  }

  // --- tunnel plane: one POST action endpoint, mirroring the IPC methods ---
  if (method === 'GET' && path === '/tunnels') {
    return engine.request('tunnels.list', undefined, { timeoutMs: 30000 })
  }
  if (method === 'POST' && path === '/tunnels') {
    const op = String(body.op ?? '')
    const allowed = ['upsertConnection', 'deleteConnection', 'testConnection', 'trustHostKey', 'upsertRule', 'deleteRule', 'startRule', 'stopRule', 'stopAll', 'port', 'portFree', 'groups', 'order'] as const
    if (!(allowed as readonly string[]).includes(op)) throw new Error('unknown tunnel op: ' + op)
    return engine.request('tunnels.' + op, body.params ?? {}, { timeoutMs: 120000 })
  }

  throw new Error('no route for ' + method + ' ' + path)
}
