/**
 * DeepSeek Harness plugin that mounts MCP servers declared in the widely
 * adopted '.mcp.json' format as '@deepseek-ai/dsh-mcp-client' instances.
 *
 * Tools register at LOAD time only and never change afterwards: the global
 * layer settles once at host activation, the per-workspace layer once at
 * session creation. A live-mutating tool set would invalidate every prompt
 * cache prefix and desync a session's history from its capabilities, so
 * file edits apply to the NEXT load (host restart for the global layer, new
 * session for a workspace), never to a running one.
 *
 * Three files are read; a server named by several is taken from the LATER
 * layer (later wins per name):
 *   1. global:            '~/.agents/.mcp.json'   ('globalFile' config)
 *   2. project root:      '<projectRoot>/.mcp.json'     (Claude Code layout)
 *   3. project agents dir '<projectRoot>/.agents/.mcp.json'
 * 'projectRoot' defaults to the process working directory; the project paths
 * can be pinned with the 'projectFile' config.
 *
 * File format (the 'mcpServers' layout shared by MCP-capable clients):
 *   {
 *     "mcpServers": {
 *       "local": { "command": "npx", "args": ["-y", "@some/server"],
 *                  "env": { "KEY": "value" } },
 *       "remote": { "url": "https://host/mcp", "headers": {} }
 *     }
 *   }
 *
 * Each entry becomes one mcp-client instance whose tools register on
 * 'ctx.tools' as 'mcp__<serverName>__<tool>'. Entries with "disabled": true
 * (or named in the adapter's 'disable' config) are skipped. Unknown keys in
 * any file are ignored so files authored for other MCP clients load as-is.
 *
 * With 'project: session' (the per-workspace mode), the host mounts only
 * the global layer; every agent/session instead gets ITS workspace's project
 * servers registered into that agent's own scope, so sessions see exactly
 * their project's servers (plus the global ones). Connections are shared per
 * project directory, and the session-mode bridge talks the MCP protocol
 * directly, so the global mcp-client name-uniqueness check does not apply.
 *
 * 'watch' (default false) opts into live file watching for deployments that
 * accept the cache trade-off: saving a layer file re-reads all layers and
 * swaps the mounted servers. A bad edit (invalid JSON, invalid entry) is
 * logged and the current servers stay mounted.
 *
 * A fourth, opt-in DISCOVERY layer ('gateway' config) mounts every MCP a
 * local-mcp-gateway instance hosts, asked over its admin API — the gateway
 * panel becomes the single source of truth and its bearer token is resolved
 * automatically (see './gateway.ts'). File entries still win per name.
 *
 * This module is the orchestrator only: validation lives in './config.ts',
 * file planning in './plan.ts', host-aware imports in './loader.ts', the
 * session-mode bridge in './session.ts', the GUI projection in
 * './settings.ts', and the embedded-gateway supervisor in './embed.ts'.
 *
 * @module dsh-mcp-adapter
 */

import { watch } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { validateConfig } from './config.js'
import { planServers } from './plan.js'
import { importMcpClient, importMcpSdk, importSchemastery } from './loader.js'
import { installWorkspaceTools } from './session.js'
import { SETTINGS_NAMESPACE, buildGatewaySectionSchema, projectGatewayEntry, gatewayConfigFrom, type GatewaySection, type SchemaBuilder, type SettingsService } from './settings.js'
import { discoverGateway, type GatewayConfig } from './gateway.js'
import { createEmbed, type EmbedSupervisor } from './embed.js'
import { createEngineSupervisor, reapOrphanedEngines, type EngineSupervisor } from './runtime/engine-supervisor.js'
import { publishEngine } from './runtime/engine-shared.js'
import { readListener, resolveListener } from './host/listener.js'
import { createConfigService } from './config/service.js'
import { mountBridge, type WebServerFace } from './host/api.js'
import type { Context, PluginHandle, ScopedContext } from './cordis.js'

// Re-exported for compatibility with the pre-split module surface.
export { projectGatewayEntry, gatewayConfigFrom } from './settings.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'mcp-json-adapter'

/**
 * No service injections. The loader (when present) is read opportunistically
 * via 'ctx.get' so the plugin also mounts inside loader-less compositions.
 */
export const inject: string[] = []

/** Debounce for file-change reloads (ms); editors fire bursts of events per save. */
const RELOAD_DEBOUNCE_MS = 400

/**
 * Read every .mcp.json layer and mount the servers as mcp-client child
 * plugins, then keep them synced with the files. Child fibers are owned by
 * this plugin's fiber, so disposal or HMR of the adapter entry tears every
 * server down with it.
 * @param ctx - plugin context.
 * @param config - adapter config from the loader entry.
 * @throws when a file is malformed or any server entry is invalid; nothing is
 *   mounted in that case.
 */
export async function apply(ctx: Context, config: unknown): Promise<void> {
  const resolved = validateConfig(config)
  if (resolved.engine !== null) {
    const { startUnifiedHost } = await import('./host/unified.js')
    await startUnifiedHost(ctx, resolved)
    return // engine + agent-plane is exclusive; never mount the legacy global chain
  }
  const mcpClient = await importMcpClient(ctx)
  const files = resolved.project === 'session'
    ? [resolved.globalFile]
    : [resolved.globalFile].concat(resolved.projectFiles)
  const patchGateway = resolved.gateway
  let currentSection: () => GatewaySection = () => projectGatewayEntry(patchGateway)

  // The browser half's management bridge: same-origin routes over the
  // webServer service, fenced (loopback Host + same-origin markers), backed
  // by the config service and the engine supervisor. The seat is optional —
  // without it (headless compositions) everything else still runs.
  const configService = createConfigService({
    storageDir: defaultEngineStorageDir(),
    ...(resolved.globalFile !== undefined ? {} : {}),
  })
  ctx.inject(['webServer'], (webCtx) => {
    const web = (webCtx as Context & { webServer: WebServerFace }).webServer
    return mountBridge(web, {
      config: configService, engine: () => engineSup, storageDir: defaultEngineStorageDir(),
      listenerConfig: () => resolved.engine ?? undefined,
    }, {})
  })
  /** Embedded gateway process supervisor, created lazily by performSync. */
  let embed: EmbedSupervisor | undefined
  /** Plugin-owned engine supervisor (the new unified path), lazily created. */
  let engineSup: EngineSupervisor | undefined

  let handles: PluginHandle[] = []

  /**
   * One swap: plan the next generation from the files (plus the gateway
   * discovery layer when configured), dispose the previous generation, mount
   * the new one. Serialized by 'chain' so a burst of file events cannot
   * interleave swaps.
   */
  async function performSync(reason: string): Promise<void> {
    const plan = await planServers(resolved, files, (line) => ctx.logger.warn(line))
    // The gateway layer mounts what the panel hosts; an explicit .mcp.json
    // entry with the same name keeps ITS config (explicit beats discovered).
    // An unreachable gateway only warns — the file layers still mount.
    let fromGateway = 0
    let gatewayConfig = gatewayConfigFrom(currentSection(), patchGateway)
    // The plugin-owned engine replaces the legacy embed when configured: the
    // private child serves the same loopback HTTP surface, so the discovery
    // layer below works unchanged against its ephemeral origin.
    if (resolved.engine !== null && gatewayConfig !== null) {
      const storageDir = resolved.engine.storageDir ?? defaultEngineStorageDir()
      // The MCP endpoint: the plugin config decides it when it says anything,
      // otherwise what the panel stored. Read once per apply, so flipping the
      // switch takes effect on the reload the panel asks the user for.
      const listener = resolveListener(resolved.engine, readListener(storageDir))
      engineSup ??= createEngineSupervisor({
        httpPort: listener.port,
        publicMcp: listener.enabled,
        respawn: resolved.engine.respawn,
        storageDir,
        ...(resolved.engine.startupTimeoutMs !== undefined ? { startupTimeoutMs: resolved.engine.startupTimeoutMs } : {}),
      }, { info: (line: string) => ctx.logger.info(line), warn: (line: string) => ctx.logger.warn(line) })
      const ready = await engineSup.ensure().catch((error: unknown) => {
        throw new Error('mcp-json-adapter: engine failed to start: ' + String(error instanceof Error ? error.message : error))
      })
      const origin = 'http://127.0.0.1:' + String(ready.httpPort)
      gatewayConfig = { ...(gatewayConfig as GatewayConfig), url: origin, embed: null, autostart: null } as GatewayConfig
      publishEngine(engineSup)
      ctx.logger.info('mcp-json-adapter: plugin-owned engine ready at ' + origin + ' (pid ' + String(ready.pid) + ')'
        + (listener.enabled ? ' — MCP endpoint published on port ' + String(listener.port) : ' — MCP endpoint not published'))
    } else if (engineSup !== undefined) {
      const dying = engineSup
      engineSup = undefined
      await dying.dispose()
    }
    if (gatewayConfig === null && embed !== undefined) {
      const dying = embed
      embed = undefined
      await dying.dispose()
    }
    if (gatewayConfig !== null) {
      try {
        // Embedded lifecycle: the plugin owns the 19999 process. Created once,
        // re-used across reloads; 'external' or a disabled gateway releases it.
        if (gatewayConfig.embed !== null) {
          embed ??= createEmbed(gatewayConfig as Parameters<typeof createEmbed>[0], (line) => ctx.logger.info(line), (line) => ctx.logger.warn(line))
          if (!(await embed.ensure())) {
            ctx.logger.warn('mcp-json-adapter: embedded gateway is not healthy; discovery continues')
          }
        } else if (embed !== undefined) {
          const dying = embed
          embed = undefined
          await dying.dispose()
        }
        const discovered = await discoverGateway(gatewayConfig, (line) => ctx.logger.info(line))
        if (discovered !== null) {
          // SKIPPED names participate in the dedup: a file entry the user disabled
          // (or adapter config disables) must not come back through the discovery
          // layer under the same name — the tombstone survives the merge.
          const taken = new Set([
            ...plan.configs.map((c) => c.serverName as string),
            ...plan.skipped,
          ])
          for (const serverConfig of discovered.configs) {
            if (resolved.disable.has(serverConfig.serverName)) continue
            if (taken.has(serverConfig.serverName)) {
              plan.overridden.push(serverConfig.serverName + ' (gateway entry shadowed by a file entry)')
              continue
            }
            serverConfig.failOnStartupError = resolved.failOnStartupError
            if (resolved.toolCallTimeoutMs !== undefined) serverConfig.toolCallTimeoutMs = resolved.toolCallTimeoutMs
            plan.configs.push(serverConfig)
            taken.add(serverConfig.serverName)
            fromGateway += 1
          }
        }
      } catch (error) {
        const line = 'mcp-json-adapter: gateway layer failed: ' + String(error instanceof Error ? error.message : error)
        if (gatewayConfig.required) throw new Error(line)
        ctx.logger.warn(line)
      }
    }
    const previous = handles
    handles = []
    for (const handle of previous) {
      try {
        await handle.dispose()
      } catch (error) {
        ctx.logger.warn('mcp-json-adapter: old server did not dispose cleanly: ' + String(error))
      }
    }
    const mounted: PluginHandle[] = []
    for (const serverConfig of plan.configs) {
      mounted.push(ctx.plugin(mcpClient, serverConfig))
    }
    handles = mounted
    await Promise.all(mounted)
    const names = plan.configs.map((c) => c.serverName as string).sort().join(', ')
    const extras: string[] = []
    if (fromGateway > 0) extras.push(String(fromGateway) + ' from gateway')
    if (plan.overridden.length > 0) extras.push('overridden: ' + Array.from(new Set(plan.overridden)).sort().join(', '))
    if (plan.skipped.length > 0) extras.push('skipped: ' + plan.skipped.sort().join(', '))
    ctx.logger.info(
      'mcp-json-adapter: mounted ' + String(plan.configs.length) + ' MCP server(s): ' + names
      + (extras.length > 0 ? ' (' + extras.join('; ') + ')' : '')
      + (reason === 'initial' ? '' : ' [reloaded: ' + reason + ']'),
    )
  }

  // Serialized reload chain; the tail must survive failures so the next file
  // event still runs.
  let chain = performSync(reasonInitial())
  const initial = chain
  chain = chain.catch(() => {})

  // The embedded gateway process dies with this plugin fiber: graceful
  // /api/shutdown first (adapters closed, proc children tree-killed, call log
  // flushed), hard kill as the fallback - unless embed.leaveRunning set it free.
  ctx.effect(() => () => {
    const dying = embed
    embed = undefined
    void dying?.dispose()
    const dyingEngine = engineSup
    engineSup = undefined
    publishEngine(undefined)
    void dyingEngine?.dispose()
  }, 'mcp-json-adapter.embed')

  function scheduleReload(reason: string): void {
    chain = chain.then(() => performSync(reason)).catch((error) => {
      ctx.logger.error('mcp-json-adapter: reload skipped, keeping current servers: ' + String(error instanceof Error ? error.message : error))
    })
  }

  if (resolved.project === 'session') {
    const sdk = await importMcpSdk(ctx)
    ctx.effect(() => ctx.on('agent/created', (payload) => {
      const agent = payload && typeof payload === 'object' ? payload.agent : undefined
      const cwd = agent && agent.session && agent.session.header ? agent.session.header.cwd : undefined
      if (typeof cwd !== 'string' || cwd.length === 0) return
      const agentCtx = agent && agent.ctx ? agent.ctx as ScopedContext : undefined
      void installWorkspaceTools(agentCtx as ScopedContext, resolve(cwd), sdk, resolved, ctx).catch((error) => {
        ctx.logger.error('mcp-json-adapter: session workspace ' + cwd + ' tools failed: ' + String(error instanceof Error ? error.message : error))
      })
    }), 'mcp-json-adapter.agent-created')
  }

  // GUI settings: the 'mcp-gateway' namespace composes the patch-config base
  // with whatever the Requests section saves. A committed change re-runs the
  // serialized reload chain (same dispose+remount trade-off as 'watch').
  try {
    const schemastery = await importSchemastery(ctx)
    const z = typeof schemastery === 'function' ? schemastery : (schemastery as { default?: unknown }).default
    if (typeof z !== 'function' || typeof (z as { object?: unknown }).object !== 'function') {
      throw new Error('schemastery did not resolve to a builder')
    }
    const schema = buildGatewaySectionSchema(z as unknown as SchemaBuilder)
    ctx.inject(['settings'], (settingsCtx) => {
      const settings = (settingsCtx as Context & { settings: SettingsService }).settings
      // installSection fires onChange once at registration (composition of the
      // base layer); that first call is not a change, so it is swallowed to
      // keep the initial mount single.
      let installed = false
      settings.installSection(ctx, SETTINGS_NAMESPACE, schema, projectGatewayEntry(patchGateway), {
        setSource: (source) => { currentSection = source },
        onChange: () => {
          if (!installed) {
            installed = true
            return
          }
          scheduleReload('gateway settings changed')
        },
      })
    })
  } catch (error) {
    ctx.logger.warn('mcp-json-adapter: settings namespace not registered (' + String(error instanceof Error ? error.message : error) + '); gateway config stays patch-static')
  }

  if (resolved.watch) {
    const closers: Array<() => void> = []
    const timerByDir = new Map<string, NodeJS.Timeout>()
    const watchedDirs = new Set<string>()
    for (const file of files) {
      const dir = dirname(file)
      if (watchedDirs.has(dir)) continue
      watchedDirs.add(dir)
      let watcher: ReturnType<typeof watch>
      try {
        watcher = watch(dir, (event, filename) => {
          if (filename !== basename(file)) return
          let timer = timerByDir.get(file)
          if (timer !== undefined) clearTimeout(timer)
          timer = setTimeout(() => {
            timerByDir.delete(file)
            scheduleReload(file + ' changed')
          }, RELOAD_DEBOUNCE_MS)
          timer.unref()
          timerByDir.set(file, timer)
        })
      } catch {
        // A layer whose directory does not exist yet is simply not watched;
        // it is read on the next reload triggered by any other layer.
        continue
      }
      closers.push(() => watcher.close())
    }
    if (closers.length > 0) {
      ctx.effect(() => () => {
        for (const close of closers) close()
        for (const timer of timerByDir.values()) clearTimeout(timer)
      }, 'mcp-json-adapter.watch')
    }
  }

  return initial
}

/**
 * Label for the first sync, so the initial log line stays clean.
 * @returns the literal 'initial'.
 */
function reasonInitial(): string {
  return 'initial'
}

/** The plugin-private storage root (P0.5): <dsh home>/mcp-manager. */
function defaultEngineStorageDir(): string {
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'mcp-manager')
}
