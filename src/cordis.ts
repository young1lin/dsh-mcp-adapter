/**
 * Minimal compile-time surface of the cordis Context this plugin receives at
 * runtime. The host resolves the real implementation; these types describe
 * only what this codebase touches, so no external @types package is needed.
 * Where the host API is intentionally dynamic (loader internals, settings
 * scopes, agent payloads) the surface degrades to controlled optionals.
 */

/** Logger surface used by every log line in this plugin. */
export interface Logger {
  info(line: string): void
  warn(line: string): void
  error(line: string): void
}

/** Host-internal module loader (ctx.get('loader')), when present. */
export interface HostLoader {
  internal: {
    import(specifier: string, base: string, options: object): Promise<unknown>
  }
}

/** Disposable returned by ctx.plugin(); awaited during server swaps. */
export interface PluginHandle {
  dispose(): Promise<void> | void
}

/** One tool registration (session mode files these into an agent's scope). */
export interface ToolRegistration {
  name: string
  description: string
  parameters: unknown
  output: unknown
  execute: (args: unknown, exec: unknown) => Promise<unknown>
}

/** An agent's scoped context: tools register into that agent's layer only. */
export interface ScopedContext {
  tools: { register(tool: ToolRegistration): () => void }
  effect(dispose: () => unknown, label?: string): unknown
}

/** Payload of the 'agent/created' event consumed in session mode. */
export interface AgentCreatedPayload {
  agent?: {
    id?: string
    ctx?: ScopedContext
    session?: { id?: string; header?: { cwd?: string } }
  }
}

/**
 * Payload of the awaited per-step 'agent/pre-step' waterfall event.
 *
 * DSH 0.1.5 shape (packages/core/agent/src/runtime-types.ts:330): the loop
 * passes `{ messages, turn, step, signal }` (agent-loop/src/agent.ts:250) and
 * the fused agent dispatcher INJECTS `agent` into every agent-subject payload
 * (core/agent/src/dispatch.ts:113-118), so listeners receive
 * `{ agent, messages, turn, step, signal }` — there is NO `sessionId` field
 * anymore; the session id lives on `agent.id`. `sessionId` below survives only
 * as a fallback for hosts that still send the pre-0.1.5 shape.
 */
export interface AgentPreStepPayload {
  agent?: { id?: string }
  sessionId?: string
  messages?: unknown[]
  turn?: number
  step?: number
  signal?: unknown
}

/**
 * The innermost continuation of a waterfall listener.
 *
 * NOT optional in practice: cordis appends it as the last dispatch argument
 * and treats a listener that does not call it as a VETO of the rest of the
 * chain, including the loop's own built-in behaviour (cordis events.waterfall:
 * `const next = () => (cbs.shift() ?? inner)(...args)`). A listener that
 * returns anything but `next()`'s value hands the agent loop that value as
 * its step decision — which is how `agent/pre-step` returning a bare promise
 * made `decision.kind` throw on every step.
 */
export type WaterfallNext<R> = () => R | Promise<R>

/** The context cordis hands to apply(); only the used surface is declared. */
export interface Context {
  logger: Logger
  baseUrl?: string
  root?: { baseUrl?: string }
  get?(name: string): unknown
  plugin(plugin: unknown, config: unknown): PluginHandle
  effect(register: () => unknown, label?: string): unknown
  on(event: 'agent/created', listener: (payload: AgentCreatedPayload) => void): unknown
  on(event: 'agent/pre-step', listener: (payload: AgentPreStepPayload, next: WaterfallNext<unknown>) => unknown): unknown
  inject(dependencies: string[], callback: (ctx: Context) => void): unknown
}
