/**
 * The agent-plane entry (preset row `dsh-mcp-json-adapter/agent`): mounts
 * a session's MCP tools INTO THAT AGENT'S OWN SCOPE LAYER, so tool names
 * are per-session (workspace config decides them) and never leak to other
 * agents or the process (TASK P3.3 — the global auto-mount path is gone in
 * engine mode).
 *
 * The generation semantics live in ./runtime/session-runtime.ts (R2/R3):
 * logical names are separated from engine instance names, sessions restore
 * from their immutable sealed snapshot instead of the current preview, and
 * instance leases are released when the last owning session dies. This
 * module is only the wiring: the two registration barriers and the loud
 * failure surface.
 *
 * Registration barriers (TASK P3.2, re-verified against DSH 0.1.5-alpha.2):
 *   1. agent/created  — emitted once the fully configured agent is published
 *      (per-session registration starts here; the factory awaits composition
 *      setup BEFORE publish and before the first prompt assembly, but a host
 *      plugin cannot join that setup — only a preset row can).
 *   2. agent/pre-step — the loop still awaits this waterfall before every
 *      step's model REQUEST, but 0.1.5 assembles the prompt — and freezes
 *      the request's tool catalog — BEFORE dispatching it
 *      (agent-loop/src/agent.ts: systemPrompt.assemble at :245 precedes the
 *      waterfall at :249). The barrier therefore gates DISPATCH only: it can
 *      no longer add tools to request #1's catalog, only delay a request
 *      whose catalog was already fixed. Request-#1 inclusion is carried
 *      instead by (a) registration starting at agent/created, seconds before
 *      human-paced first messages, and (b) the prewarm cache in
 *      ./runtime/session-runtime.ts, which makes install() microtask-fast by
 *      removing the engine IPC round trips, so machine-driven sessions
 *      (subagents, forks stepping immediately) win the race against assembly
 *      in practice. A late registration still lands: every step re-assembles
 *      from current registry layers, at the cost of a toolsChanged series
 *      reset (agent-loop/src/agent.ts:361-368).
 *
 *      That barrier is a WATERFALL, not a notification: cordis treats a
 *      listener that does not call `next()` as a veto of the rest of the
 *      chain and hands the loop whatever the listener returned as its step
 *      decision. Awaiting the barrier and returning `next()` is therefore
 *      the whole contract — returning the barrier promise itself resolved
 *      the waterfall to `undefined`, so `decision.kind` threw on every step
 *      of every session the moment this plane was mounted.
 *
 * MOUNT POINTS. Two, and at most one wins per process:
 *   - the host plugin mounts this plane itself once its engine is published
 *     (src/host/unified.ts), so a session gets its MCP tools under WHATEVER
 *     agent preset it runs — the shipped `code` / `standard` presets
 *     included. This is the path a normal install uses, and the reason the
 *     tools no longer depend on the user hand-authoring a preset directory;
 *   - the preset row `dsh-mcp-json-adapter/agent` still mounts it directly,
 *     for deployments that want the tools on ONE preset instead of all of
 *     them. Mounting both is not an error: the second mount is refused by
 *     `mountAgentPlane`'s process guard rather than registering every tool
 *     twice into the same agent scope.
 *
 * Snapshots (TASK P3.4/P3.5, R3): the first registration freezes the
 * session's whole effective generation (defs + tool schemas, sealed); a
 * re-appearing session restores it verbatim; session-level edits stay
 * pending until a later session adopts them.
 *
 * @module dsh-mcp-adapter/agent
 */

import { createSessionRuntime, resolveRuntimeServices, type SessionRuntime } from './runtime/session-runtime.js'
import type { ScopedContext, Context, WaterfallNext } from './cordis.js'

/** Cordis plugin name (loader diagnostics). */
export const name = 'dsh-mcp-json-adapter/agent'

/** No service injections; the engine accessor is module-singleton. */
export const inject: string[] = []

/** Agent-entry config (the preset row's config block). */
export interface AgentEntryConfig {
  /** Per-call timeout forwarded to engine mcp.call (default 180s). */
  toolCallTimeoutMs?: number
}

/**
 * Whether some entry in THIS process already mounted the agent plane.
 *
 * Process-wide on purpose: the host mount and the preset row are two
 * different plugin instances, so a per-instance guard would let both
 * register `agent/created` and hand every agent its tool set twice — same
 * names, two registrations, two engine leases. The flag is released when the
 * winning mount's fiber disposes, so a reload re-arms it.
 */
let mounted = false

/**
 * Mount the per-agent MCP tool bridge onto a standing context.
 *
 * Runs ONCE per process; per-agent work hangs off the two barriers above.
 * @param ctx - the standing context to mount on (host plugin or preset row).
 * @param options - agent-entry config.
 * @returns whether this call took the mount; false means another entry holds it.
 */
export function mountAgentPlane(ctx: Context, options: AgentEntryConfig = {}): boolean {
  if (mounted) {
    ctx.logger.info('mcp-agent: session tool plane already mounted in this process — this mount is a no-op')
    return false
  }
  mounted = true
  ctx.effect(() => () => { mounted = false }, 'mcp-agent.mount-guard')
  const timeoutMs = options.toolCallTimeoutMs ?? 180000
  /** sessionId -> the registration promise barrier pre-step awaits. */
  const ready = new Map<string, Promise<void>>()

  /**
   * Process-singleton runtime, resolved lazily (the engine may be published
   * after this row mounts). The PROMISE is cached, not the resolved value:
   * two agent/created events in one tick must both await the SAME in-flight
   * resolution — caching the value would hand the second one a silent
   * undefined and no tools.
   */
  let runtimePromise: Promise<SessionRuntime | undefined> | undefined
  function runtimeOf(): Promise<SessionRuntime | undefined> {
    runtimePromise ??= resolveRuntimeServices(ctx.logger, { toolCallTimeoutMs: timeoutMs }).then((deps) => {
      if (deps === undefined) {
        ctx.logger.info('mcp-agent: no shared engine — sessions get no per-session MCP tools')
        return undefined
      }
      return createSessionRuntime(deps)
    })
    return runtimePromise
  }

  /**
   * One-time prewarm GATE: resolve the runtime, warm the global layer, and
   * clean up every probe row it created — BEFORE any session install runs.
   * The ordering is not cosmetic: a session's mcp.ensure would def-hash
   * match a prewarm probe row and start it, racing the probe's own cleanup
   * into deleting the instance underneath the registering session (seen as
   * a first session with zero tools). Awaiting the gate from every install
   * removes the interleaving; it costs one bounded wait, at most once per
   * process, and a failed prewarm still resolves the gate — sessions
   * proceed on the uncached path.
   */
  const prewarmGate: Promise<void> = runtimeOf().then(async (rt) => {
    if (rt === undefined) return
    try {
      const warm = await rt.prewarmGlobal()
      ctx.logger.info('mcp-agent: prewarmed ' + String(warm.servers) + ' engine-hosted global server(s), ' + String(warm.tools) + ' tool(s) into the session install cache')
    } catch (error) {
      ctx.logger.warn('mcp-agent: global prewarm failed: ' + String(error instanceof Error ? error.message : error))
    }
  }).catch((error: unknown) => {
    ctx.logger.warn('mcp-agent: session runtime unavailable: ' + String(error instanceof Error ? error.message : error))
  })

  ctx.effect(() => ctx.on('agent/created', (payload) => {
    const agent = payload && typeof payload === 'object' ? (payload as { agent?: { id?: string; ctx?: ScopedContext; session?: { id?: string; header?: { cwd?: string } } } }).agent : undefined
    const sessionId = agent?.id ?? agent?.session?.id
    const agentCtx = agent?.ctx
    const cwd = agent?.session?.header?.cwd
    if (sessionId === undefined || agentCtx === undefined || cwd === undefined || cwd.length === 0) return
    if (ready.has(sessionId)) return
    ready.set(sessionId, (async () => {
      await prewarmGate
      const rt = await runtimeOf()
      if (rt === undefined) return
      const workspaceId = rt.workspaceIdOf({ sessionId, cwd })
      if (workspaceId === undefined || workspaceId.length === 0) {
        ctx.logger.warn('mcp-agent: cannot resolve a workspace for session ' + sessionId + ' (cwd ' + cwd + ') — no MCP tools registered')
        return
      }
      const summary = await rt.install(agentCtx, sessionId, workspaceId)
      const detail = summary.unavailable.length > 0 ? ', unavailable: ' + summary.unavailable.sort().join(', ') : ''
      ctx.logger.info('mcp-agent: session ' + sessionId + (summary.restored ? ' restored' : ' registered') + ' ' + String(summary.tools) + ' tool(s) from ' + String(summary.servers) + ' server(s)' + detail)
    })().catch((error: unknown) => {
      // Loud failure surface: the barrier resolves (the session proceeds
      // without its MCP tools) but the error is fully reported, never
      // silently swallowed.
      const stack = error instanceof Error && error.stack !== undefined ? '\n' + error.stack : ''
      const code = (error as { code?: unknown }).code
      ctx.logger.error('mcp-agent: session ' + sessionId + ' tool registration failed [' + String(code) + ']: ' + String(error instanceof Error ? error.message : error) + stack)
    }))
  }), 'mcp-agent.agent-created')

  ctx.effect(() => ctx.on('agent/pre-step', async (payload, next: WaterfallNext<unknown>) => {
    // Await the barrier, then CONTINUE the waterfall. This listener GATES the
    // step's dispatch; it does not decide it. Returning anything but next()'s
    // value hands the agent loop that value as its step decision.
    // 0.1.5 payload: { agent, messages, turn, step, signal } — the session id
    // is agent.id (no sessionId field); the legacy field stays as fallback.
    const id = payload && typeof payload === 'object'
      ? (payload as { agent?: { id?: string } }).agent?.id ?? (payload as { sessionId?: string }).sessionId
      : undefined
    const pending = id !== undefined ? ready.get(id) : undefined
    if (pending !== undefined) await pending
    return await next()
  }), 'mcp-agent.pre-step')

  ctx.effect(() => () => ready.clear(), 'mcp-agent.ready-map')
  return true
}

/**
 * Preset-row entry point: mount the plane on the preset's standing context.
 * A host that already mounted it wins and this apply does nothing.
 * @param ctx - the preset row's context.
 * @param config - the row's config block.
 */
export async function apply(ctx: Context, config: unknown): Promise<void> {
  const options: AgentEntryConfig = config === null || typeof config !== 'object' ? {} : config as AgentEntryConfig
  mountAgentPlane(ctx, options)
  await Promise.resolve()
}
