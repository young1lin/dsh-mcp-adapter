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
 * Registration barriers (TASK P3.2), in order of guarantee:
 *   1. agent/created  — scope-filtered to agents on THIS preset; starts the
 *      per-agent registration immediately (human-paced sessions are covered
 *      by the gap before their first message).
 *   2. agent/pre-step — the loop awaits this waterfall BEFORE every step's
 *      model request (agent-loop preStep:501 → step:555), so the pending
 *      registration promise is AWAITED here: machine-driven sessions
 *      (subagents, forks) get their tools in request #1 or the step fails
 *      loudly — never a silent tool-less turn. The first step therefore
 *      still waits for registration; failures are logged as errors (code +
 *      stack), never silently swallowed into a quiet success.
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

  ctx.effect(() => ctx.on('agent/created', (payload) => {
    const agent = payload && typeof payload === 'object' ? (payload as { agent?: { id?: string; ctx?: ScopedContext; session?: { id?: string; header?: { cwd?: string } } } }).agent : undefined
    const sessionId = agent?.id ?? agent?.session?.id
    const agentCtx = agent?.ctx
    const cwd = agent?.session?.header?.cwd
    if (sessionId === undefined || agentCtx === undefined || cwd === undefined || cwd.length === 0) return
    if (ready.has(sessionId)) return
    ready.set(sessionId, (async () => {
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
    // step; it does not decide it. Returning anything but next()'s value
    // hands the agent loop that value as its step decision.
    const id = payload && typeof payload === 'object' ? (payload as { agentId?: string; sessionId?: string }).sessionId ?? (payload as { agent?: { id?: string } }).agent?.id : undefined
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
