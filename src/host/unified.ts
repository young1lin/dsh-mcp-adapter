/**
 * Unified host activation: one engine, one config service, no global tools.
 *
 * "No global tools" means no tool is registered on the process-wide layer —
 * NOT that sessions go without. Each session's tools are registered into that
 * session's own agent scope by the agent plane, which this module mounts
 * itself (`mountAgentPlane`) as soon as the engine is published.
 *
 * Mounting it here rather than leaving it to the preset row is the fix for
 * the failure this replaced: in engine mode `apply()` returns before the
 * legacy `agent/created` hook is reached, so the ONLY path that registered
 * session tools was a hand-authored preset directory carrying the
 * `dsh-mcp-json-adapter/agent` row. A deployment that never authored one —
 * i.e. every default install — logged "tools are registered only in agent
 * scopes" and then registered none, in any session, ever. `engine.sessionTools:
 * false` explicitly disables session tool registration.
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Context } from '../cordis.js'
import type { ResolvedConfig } from '../config.js'
import { createConfigService } from '../config/service.js'
import { mountAgentPlane } from '../agent.js'
import { createEngineSupervisor, type EngineSupervisor } from '../runtime/engine-supervisor.js'
import { publishRuntime, sharedRuntime } from '../runtime/engine-shared.js'
import { workspaceRootOfFallbackId } from '../runtime/session-runtime.js'
import { mountBridge, type WebServerFace } from './api.js'

interface Workspace { id: string; path: string; title?: string; sessionIds?: Iterable<string> }
interface Registry { list(): Workspace[]; get(id: string): Workspace | undefined }
function service(ctx: Context, key: string): unknown {
  try { return ctx.get?.(key) ?? (ctx as unknown as Record<string, unknown>)[key] } catch { return undefined }
}
function canonical(path: string): string {
  const value = resolve(path)
  return process.platform === 'win32' ? value.toLowerCase() : value
}
export async function startUnifiedHost(
  ctx: Context, resolved: ResolvedConfig,
  factory: typeof createEngineSupervisor = createEngineSupervisor,
): Promise<void> {
  if (resolved.engine === null) throw new Error('unified host requires engine configuration')
  if (sharedRuntime() !== undefined) throw new Error('MCP plugin already active; remove duplicate loader entry')
  const storageDir = resolved.engine.storageDir ?? join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'mcp-manager')
  const registry = () => service(ctx, 'workspaceRegistry') as Registry | undefined
  const workspaces = () => registry()?.list() ?? []
  const rootOfRegistered = (id: string | undefined): { root: string } | undefined => {
    const ws = id === undefined ? undefined : registry()?.get(id)
    return ws === undefined ? undefined : { root: ws.path }
  }
  /**
   * The BROWSER's view. Its resolver refuses any id the host registry does not
   * know, so a request cannot name a directory the app never opened: an id is
   * never interpreted as a path on this instance (config/service.ts:69).
   */
  const config = createConfigService({
    storageDir, globalFile: resolved.globalFile,
    workspaceResolver: { resolve: rootOfRegistered },
  })
  /**
   * The SESSION plane's view, over the same storage and files.
   *
   * It exists because the ids differ, not the data. When the host registry
   * cannot name a session's cwd — no workspaceRegistry service, a cwd the app
   * never registered, a session opened outside a project — the runtime falls
   * back to an id that ENCODES the cwd (fallbackWorkspaceId). Handing such an
   * id to the strict resolver above threw `unknown workspace` out of preview,
   * and the whole session lost its tools: not just the project layer it could
   * not resolve, but the global entries that never needed a workspace at all.
   *
   * Decoding that id here is not a widening of the browser's reach: only the
   * agent plane holds this instance, and the only ids it ever passes are the
   * ones it derived from the agent's own cwd.
   */
  const sessionConfig = createConfigService({
    storageDir, globalFile: resolved.globalFile,
    workspaceResolver: { resolve: (id) => {
      const registered = rootOfRegistered(id)
      if (registered !== undefined) return registered
      const root = id === undefined ? undefined : workspaceRootOfFallbackId(id)
      return root === undefined || root.length === 0 ? undefined : { root }
    } },
  })
  // No HTTP MCP endpoint in the MCP-services-only build. Preserve legacy
  // engine.httpPort/publicMcp config so existing installs still start, but
  // explicitly override it (and never read the old listener.json) on spawn.
  if (resolved.engine.publicMcp === true || resolved.engine.httpPort !== undefined) {
    ctx.logger.warn('mcp-json-adapter: engine.publicMcp / engine.httpPort are ignored; the external MCP endpoint is disabled')
  }
  const engine: EngineSupervisor = factory({
    ...resolved.engine, storageDir, httpPort: 0, publicMcp: false,
  }, { info: (line) => ctx.logger.info(line), warn: (line) => ctx.logger.warn(line) })
  let disposed = false
  const cleanup = async () => {
    if (disposed) return
    disposed = true
    if (sharedRuntime()?.engine === engine) publishRuntime(undefined)
    await engine.dispose()
  }
  ctx.effect(() => cleanup, 'mcp-manager.engine')
  try {
    const ready = await engine.ensure()
    if (disposed) { await engine.dispose(); throw new Error('MCP plugin disposed during startup') }
    publishRuntime({
      engine, config: sessionConfig, storageDir,
      workspaceIdFor: (cwd, sessionId) => {
        const all = workspaces()
        return all.find((ws) => ws.sessionIds !== undefined && [...ws.sessionIds].includes(sessionId) && canonical(ws.path) === canonical(cwd))?.id
          ?? all.find((ws) => canonical(ws.path) === canonical(cwd))?.id
      },
    })
    // The session tool plane, on the same fiber as the engine that backs it:
    // disposing this plugin takes the agent barriers down with it. Mounted
    // AFTER publishRuntime because the plane caches its first runtime
    // resolution — resolving against an unpublished engine would cache
    // "no engine" for the life of the process.
    if (resolved.engine.sessionTools) mountAgentPlane(ctx, resolved.toolCallTimeoutMs !== undefined ? { toolCallTimeoutMs: resolved.toolCallTimeoutMs } : {})
    ctx.inject(['webServer'], (webCtx) => {
      const web = service(webCtx, 'webServer') as WebServerFace | undefined
      if (web === undefined) return
      const dispose = mountBridge(web, { config, engine: () => disposed ? undefined : engine, storageDir,
        workspaces: () => workspaces().map(({ id, path, title }) => ({ id, path, title })),
      })
      webCtx.effect(() => dispose, 'mcp-manager.web-bridge')
    })
    ctx.logger.info('mcp-manager: private engine ready (pid ' + ready.pid + '); session tools '
      + (resolved.engine.sessionTools ? 'register per agent scope from this host mount' : 'disabled by engine.sessionTools: false'))
  } catch (error) { await cleanup(); throw error }
}
