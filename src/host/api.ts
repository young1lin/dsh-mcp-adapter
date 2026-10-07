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

/** Dependencies needed by the MCP services page and conversation tab. */
export interface BridgeDeps {
  config: ConfigService
  engine: () => EngineSupervisor | undefined
  /** Plugin storage root for session snapshots and view metadata. */
  storageDir: string
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
    const forNext = req.query.get('next') === '1'
    let workspaceId = ws
    if (forNext && ss !== undefined) {
      const { readSessionFile, sessionFilePath, isRestorableSnapshot } = await import('../config/session-store.js')
      const { file } = await readSessionFile(sessionFilePath(deps.storageDir, ss))
      if (!isRestorableSnapshot(file.snapshot)) throw Object.assign(new Error('Cannot verify new-session configuration without a valid registration snapshot'), { code: 'SCOPE' })
      // Match create({cwd}) for THIS conversation, not another active pane.
      workspaceId = file.snapshot.workspaceId
    }
    const preview = await deps.config.preview({ ...(workspaceId !== undefined ? { workspaceId } : {}), ...(!forNext && ss !== undefined ? { sessionId: ss } : {}) })
    return forNext ? { ...preview, forNextSession: true } : preview
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
    const { snapshotView, configurationChanges } = await import('./session-view.js')
    const { file, problem } = await readSessionFile(sessionFilePath(deps.storageDir, ss))
    const snap = file.snapshot
    let snapshot: import('../shared/session-view.js').SessionSnapshotView | undefined
    let changes: import('../shared/session-view.js').SessionConfigurationChanges | undefined
    if (isRestorableSnapshot(snap)) {
      snapshot = snapshotView(snap)
      try {
        const next = await deps.config.preview({ workspaceId: snap.workspaceId, maskSecrets: false })
        changes = configurationChanges(snap, next)
      } catch {
        // A broken latest config must not hide the registered catalog or
        // replace it with an empty/current preview. Config tab reports errors.
      }
    } else if (snap !== undefined && Array.isArray((snap as { tools?: unknown }).tools)) {
      const legacy = snap as { revision?: string; registeredAt?: string; tools: string[] }
      snapshot = { revision: legacy.revision ?? '', registeredAt: legacy.registeredAt ?? '', tools: legacy.tools, restorable: false }
    }
    return { sessionId: ss, revision: revisionOfSession(file), capabilities: { nextSessionPreview: true }, ...(problem !== undefined ? { snapshotProblem: 'unreadable' } : {}), ...(snapshot !== undefined ? { snapshot } : {}), ...(changes !== undefined ? { configurationChanges: changes } : {}) }
  }

  // --- engine plane ---
  const engine = deps.engine()
  if (method === 'GET' && path === '/engine') {
    if (engine === undefined) return { off: true }
    const status = await engine.request('engine.status', undefined, { timeoutMs: 30000 }) as { mcps?: unknown[] }
    // MCP services needs only the list: do not expose endpoint or token metadata.
    return { mcps: status.mcps ?? [] }
  }
  if (engine === undefined) throw new Error('engine is not enabled')

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

  throw new Error('no route for ' + method + ' ' + path)
}
