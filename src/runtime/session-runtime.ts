/**
 * Session runtime (docs/progress-review.md R2/R3): the plane that turns one
 * DSH session's effective MCP configuration into engine instances plus
 * agent-scoped tools, with REAL generation semantics.
 *
 * R2 — logical names vs engine instance names:
 *   The user-facing server name (the tool namespace, what previews and the
 *   UI show) is never used as the engine addressing key. Every active entry
 *   is ensured on the engine under a minted INSTANCE name derived from
 *   (workspaceId, logical name, effective def), so:
 *     - two workspaces using the same logical name never share or overwrite
 *       each other's instance ("never the same logical name globally");
 *     - a config edit produces a new def => a new instance name; sessions
 *       holding the old generation keep their old instance untouched (no
 *       updateDef restart under them, no connection-target swap mid-session);
 *     - sessions in one workspace with the SAME effective def share one
 *       engine instance (the memory goal of TASK P3.1) via host-side leases.
 *   The engine's existing mcp.ensure RPC is used as-is: a live instance is
 *   detected first (engine.status) and reused WITHOUT re-ensuring, because
 *   ensure-on-existing maps to registry.updateDef, which stops and replaces
 *   the instance — exactly the mutation this module exists to prevent.
 *
 * R3 — immutable, restorable snapshots:
 *   The first registration of a session freezes its whole effective
 *   generation (per server: logical name, instance name, effective def with
 *   real secrets, tool schemas) into the sealed session file (see
 *   config/session-store.ts, snapshot v2) and nothing rewrites it afterwards.
 *   A session that appears again — host restart, restore, re-mounted preset
 *   row — replays THAT generation instead of re-reading the current preview:
 *   tools keep their frozen schemas and the engine instance is re-ensured
 *   from the frozen def. A server whose snapshot generation cannot be
 *   brought back (broken command, vanished adapter) is reported unavailable
 *   for that session; it is NEVER silently substituted with the current
 *   config (no privilege drift). Legacy or malformed generations fail closed;
 *   missing frozen schemas are never replaced from current configuration.
 *
 * Cleanup / leases:
 *   The runtime keeps per-process leases (instance -> owning sessionIds).
 *   When a session scope dies, its lease drops; the LAST owner releases the
 *   instance on the engine. Release prefers the dedicated mcp.release RPC
 *   (parent-planned; see the contract note at releaseOnEngine) and falls
 *   back to mcp.remove, which is safe HERE ONLY because instance names are
 *   minted per (workspace, def) and can never collide with a
 *   user-configured or panel-created server name — there is no per-name
 *   global mutation anywhere in this module.
 *
 * Workspace identity:
 *   The canonical services (storage root, config service, host workspace-id
 *   resolver) are consumed from the parent-published contract in
 *   runtime/engine-shared.ts when present (see resolveRuntimeServices); the
 *   local fallback mirrors the host plugin's own derivation so both planes
 *   agree on one storage tree even before the contract lands.
 *
 * @module dsh-mcp-adapter/runtime/session-runtime
 */

import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { sharedEngine } from './engine-shared.js'
import type { EngineSupervisor } from './engine-supervisor.js'
import type { ConfigService } from '../config/service.js'
import type { McpDefinition, ScopePreview } from '../config/types.js'
import {
  isRestorableSnapshot,
  readSessionFile,
  sessionFilePath,
  writeSnapshotImmutable,
  type SessionSnapshot,
  type SessionSnapshotServer,
  type SnapshotTool,
} from '../config/session-store.js'
import { standardToNative } from '../config/transfer.js'
import { INSTANCE_NAME_MAX, instanceTail } from '../shared/instance-name.js'
import type { Logger, ScopedContext } from '../cordis.js'

// --- mcp-client-shaped helpers (moved here from the retired legacy session
// bridge; the runtime is their only remaining consumer) -----------------------

/**
 * Model-facing public tool name, mirroring mcp-client's publicToolName:
 * 'mcp__<server>__<raw>' normalized to [A-Za-z0-9_-], with a 12-hex sha256
 * identity suffix appended when normalization is lossy or the name is long.
 * @param serverName - the server namespace.
 * @param rawName - the MCP server's own tool name.
 * @returns the scoped model-facing tool name.
 */
export function publicNameLite(serverName: string, rawName: string): string {
  const joined = 'mcp__' + serverName + '__' + rawName
  const normalized = joined.replace(/[^A-Za-z0-9_-]/g, '_')
  if (normalized === joined && normalized.length <= 64) return normalized
  const hash = createHash('sha256').update(serverName + '\0' + rawName).digest('hex').slice(0, 12)
  return normalized.slice(0, 64 - 12 - 1) + '_' + hash
}

/**
 * Flatten MCP content blocks to text, mirroring mcp-client's extractText.
 * @param content - the result content blocks.
 * @returns the joined text projection.
 */
function extractTextLite(content: unknown[]): string {
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') {
      parts.push('[unsupported content type: ' + String(block) + ']')
    } else if ((block as Record<string, unknown>).type === 'text') {
      const text = (block as Record<string, unknown>).text
      parts.push(typeof text === 'string' ? text : '')
    } else if ((block as Record<string, unknown>).type === 'image') {
      const mime = (block as Record<string, unknown>).mimeType
      parts.push('[image: ' + String(mime ?? 'unknown') + ', content discarded]')
    } else if ((block as Record<string, unknown>).type === 'audio') {
      const mime = (block as Record<string, unknown>).mimeType
      parts.push('[audio: ' + String(mime ?? 'unknown') + ', content discarded]')
    } else if ((block as Record<string, unknown>).type === 'resource' || (block as Record<string, unknown>).type === 'resource_link') {
      parts.push('[resource: content discarded]')
    } else {
      parts.push('[unsupported content type: ' + String((block as Record<string, unknown>).type) + ']')
    }
  }
  return parts.join('')
}

/** Rendered output element createOutputLite's render returns. */
interface OutputTextElement {
  type: 'text'
  text: string
}

/** The output descriptor shape for one bridged tool (mcp-client's shape). */
interface ToolOutput {
  schema: Record<string, unknown>
  render: (args: unknown, value: unknown) => OutputTextElement[]
}

/**
 * Create the output descriptor for one bridged tool (mcp-client's shape).
 * @param rawName - the MCP tool name, for render fallbacks.
 */
function createOutputLite(rawName: string): ToolOutput {
  return {
    schema: {
      type: 'object',
      properties: {
        content: { type: 'array', items: {} },
        structuredContent: {},
      },
      required: ['content'],
      additionalProperties: false,
    },
    render(_args: unknown, value: unknown) {
      const result = value as { content?: unknown } | null
      const content = result && typeof result === 'object' && Array.isArray(result.content) ? result.content : []
      return [{ type: 'text', text: extractTextLite(content) || ('(no output from ' + rawName + ')') }]
    },
  }
}

/**
 * The supervisor surface this runtime needs — declared HERE, decoupled from
 * EngineSupervisor's evolving option types, so in-flight edits to the
 * supervisor module cannot break this plane. Method-shaped on purpose:
 * bivariance makes the live supervisor assignable regardless of whether its
 * own opts declare a narrower signal type.
 */
export interface RuntimeSupervisor {
  request(method: string, params?: unknown, opts?: { timeoutMs?: number; signal?: unknown }): Promise<unknown>
}

/** Narrow config-service surface consumed here (injectable for tests). */
export type RuntimeConfigService = Pick<ConfigService, 'preview'>

/** Everything one runtime needs; all of it injectable. */
export interface SessionRuntimeDeps {
  supervisor: RuntimeSupervisor
  config: RuntimeConfigService
  /** Plugin-private storage root (same tree the host config service uses). */
  storageDir: string
  logger: Logger
  /** Per-call timeout forwarded to engine mcp.call (default 180s). */
  toolCallTimeoutMs?: number
  /** Per-server ensure/start/tools timeout (default 60s). */
  ensureTimeoutMs?: number
  /**
   * Identity of the current engine child (the supervisor's epoch()). The
   * warm install cache binds every entry to the value at fill time and
   * treats an entry as stale the moment it changes (engine respawned: every
   * session-scoped instance is gone). Absent = the caller vouches that the
   * supervisor outlives its cache entries unchanged (tests' fake
   * supervisors); warming then never invalidates.
   */
  engineEpoch?: () => string | undefined
  /**
   * Canonical workspace identity for one agent event. The published host
   * resolver returns the HOST workspace id; the fallback canonicalizes the
   * cwd. Returning undefined means "cannot place this session" — it gets no
   * MCP tools rather than tools under a guessed identity.
   */
  workspaceIdOf?: (input: { sessionId: string; cwd: string }) => string | undefined
}

/** Summary of one session install (logging + tests). */
export interface InstallSummary {
  /** Whether the immutable snapshot was replayed (true) or computed fresh. */
  restored: boolean
  servers: number
  tools: number
  /** Server logical names that could not be brought up (restore failures included). */
  unavailable: string[]
}

/**
 * Canonicalize a raw cwd: absolute, separator-normalized. This is the
 * identity SEED, not the workspace id itself.
 */
export function canonicalWorkspaceId(cwd: string): string {
  return resolve(cwd)
}

/**
 * Fallback workspace id for a cwd (used only while the host has not
 * published SharedRuntime): the canonical path reversibly encoded as
 * base64url, whose alphabet is exactly the config service's legal id
 * charset. Deterministic across restarts, so project native catalogs stay
 * keyed stably. Absurdly long paths (encoded > 159 chars) degrade to an
 * irreversible stable hash — such a workspace reads global-only until the
 * host resolver takes over.
 */
export function fallbackWorkspaceId(cwd: string): string {
  const canonical = canonicalWorkspaceId(cwd)
  const encoded = Buffer.from(canonical, 'utf8').toString('base64url')
  if (encoded.length <= 159 && encoded.length > 0) return 'w' + encoded
  return 'wp' + createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 40)
}

/** Reverse of fallbackWorkspaceId ('wp' hash ids are not reversible). */
export function workspaceRootOfFallbackId(id: string): string | undefined {
  if (id.startsWith('wp') && id.length === 42) return undefined
  if (!id.startsWith('w') || id.length < 2) return undefined
  try {
    return Buffer.from(id.slice(1), 'base64url').toString('utf8')
  } catch {
    return undefined
  }
}

/** Order-insensitive JSON projection so def keys never split an instance. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return value === undefined ? 'null' : JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  const record = value as Record<string, unknown>
  return '{' + Object.keys(record).sort().map((key) => JSON.stringify(key) + ':' + stableStringify(record[key])).join(',') + '}'
}

/**
 * Mint the engine instance name for one (workspaceId, logical name, def).
 * Deterministic: identical identity triple => identical name (two sessions
 * in one workspace with the same effective def SHARE the instance); any
 * change to the def => a different name (a new generation, old leases
 * untouched). The logical name rides along as a readable tail; the hashes
 * keep it globally unique so the bare logical name is never addressed on
 * the engine.
 */
export function instanceNameFor(workspaceId: string, logical: string, def: unknown): string {
  const workspaceKey = createHash('sha256').update(workspaceId, 'utf8').digest('hex').slice(0, 10)
  const defKey = defKeyOf(def)
  // The tail rule lives in shared/instance-name.ts, because the engine's call
  // log has to run it in reverse to find the logs a session minted.
  return ('s' + workspaceKey + '-' + defKey + '-' + instanceTail(logical)).slice(0, INSTANCE_NAME_MAX)
}

/**
 * Stable hash of a definition — the SAME key the engine's mcp.ensure matches
 * instances by (one definition, one hosted instance), so it is also the
 * correct cache key for "which instance + which tools serve this def".
 */
function defKeyOf(def: unknown): string {
  return createHash('sha256').update(stableStringify(def), 'utf8').digest('hex').slice(0, 10)
}

/** Preview-level fingerprint: name@revision pairs, order-insensitive. */
function configRevisionOf(preview: ScopePreview): string {
  const text = preview.entries.map((entry) => entry.name + '@' + entry.revision).sort().join('\n')
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
}

/** Hard caps keeping a snapshot honest but bounded. */
const MAX_SERVERS_PER_SNAPSHOT = 100
const MAX_TOOLS_PER_SERVER = 1000

/** Host-side content budget for one tool result (unchanged from the previous agent bridge). */
const MAX_RESULT_BYTES = 512 * 1024

/**
 * The parent-published engine-shared contract (src/runtime/engine-shared.ts,
 * parent-owned — never edited here):
 *
 *   export interface SharedRuntime {
 *     engine: EngineSupervisor
 *     config: ConfigService       // the host-owned service (canonical preview/save)
 *     storageDir: string          // canonical <dsh home>/mcp-manager
 *     workspaceIdFor(cwd: string, sessionId: string): string | undefined
 *   }
 *   export function sharedRuntime(): SharedRuntime | undefined
 *
 * Consumed opportunistically: when the publisher has not run yet (engine
 * enabled but services not published), the documented fallback below keeps
 * the two planes on one storage tree.
 */
interface SharedRuntimeLike {
  storageDir: string
  config: RuntimeConfigService
  workspaceIdFor?: (cwd: string, sessionId: string) => string | undefined
}

type SharedModuleLike = typeof import('./engine-shared.js') & {
  sharedRuntime?: () => SharedRuntimeLike | undefined
}

/** Plugin-private storage root — identical derivation to the host plugin (index.ts). */
export function defaultSessionStorageDir(): string {
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'mcp-manager')
}

/**
 * Resolve the deps for the process-singleton runtime: the shared supervisor
 * plus whichever canonical services exist. Prefers the parent-published
 * engine-shared contract; falls back to the host plugin's own storage
 * derivation and a cwd-canonical workspace identity (documented divergence:
 * host workspace IDs land with the published resolver).
 */
export async function resolveRuntimeServices(logger: Logger, options: { toolCallTimeoutMs?: number; ensureTimeoutMs?: number } = {}): Promise<SessionRuntimeDeps | undefined> {
  const engine = sharedEngine()
  if (engine === undefined) return undefined // engine block not enabled: no per-session tools
  // Bind the warm cache's generation to the engine child (supervisor epoch),
  // when this build's supervisor exposes one. Defensively optional: the
  // runtime accepts any request-shaped supervisor (tests), and without an
  // epoch the warm cache simply never invalidates.
  const engineEpoch = typeof (engine as EngineSupervisor).epoch === 'function'
    ? () => (engine as EngineSupervisor).epoch()
    : undefined
  const sharedModule = await import('./engine-shared.js') as SharedModuleLike
  const shared = typeof sharedModule.sharedRuntime === 'function' ? sharedModule.sharedRuntime() : undefined
  if (shared !== undefined && shared !== null && typeof shared.storageDir === 'string' && shared.config !== null && typeof shared.config === 'object' && typeof shared.config.preview === 'function') {
    return {
      supervisor: engine,
      config: shared.config,
      storageDir: shared.storageDir,
      logger,
      toolCallTimeoutMs: options.toolCallTimeoutMs,
      ensureTimeoutMs: options.ensureTimeoutMs,
      engineEpoch,
      workspaceIdOf: (input) => (typeof shared.workspaceIdFor === 'function' ? shared.workspaceIdFor(input.cwd, input.sessionId) : undefined) ?? fallbackWorkspaceId(input.cwd),
    }
  }
  const { createConfigService } = await import('../config/service.js')
  const storageDir = defaultSessionStorageDir()
  const config = createConfigService({
    storageDir,
    // Fallback resolver: workspace ids are the reversible base64url form of
    // the canonical cwd (see fallbackWorkspaceId) — ids the config service
    // accepts and the same tree the host plugin reads.
    workspaceResolver: {
      resolve: (workspaceId) => {
        const root = workspaceRootOfFallbackId(String(workspaceId))
        return root === undefined || root.length === 0 ? undefined : { root }
      },
    },
  })
  return {
    supervisor: engine,
    config,
    storageDir,
    logger,
    toolCallTimeoutMs: options.toolCallTimeoutMs,
    ensureTimeoutMs: options.ensureTimeoutMs,
    engineEpoch,
    workspaceIdOf: (input) => fallbackWorkspaceId(input.cwd),
  }
}

/** One engine instance lease: the sessions currently holding it. */
interface Lease {
  /** A recreated context can overlap the previous context for the SAME id. */
  refs: Map<string, number>
  definitionKey: string
}

/** The session runtime handle returned by createSessionRuntime. */
export interface SessionRuntime {
  /** Register one session's MCP tools (barrier body; see src/agent.ts). */
  install(agentCtx: ScopedContext, sessionId: string, workspaceId: string): Promise<InstallSummary>
  /** Canonical workspace identity for one agent event. */
  workspaceIdOf(input: { sessionId: string; cwd: string }): string | undefined
  /**
   * Warm the install cache from the GLOBAL layer, ahead of any session, for
   * definitions the engine ALREADY HOSTS. Fire-and-forget at host
   * activation: every session's install() then registers those tools
   * without an engine round trip, which is what keeps machine-driven
   * sessions (subagents, forks stepping immediately after publish) from
   * losing their first request to the assemble-vs-registration race
   * (DSH 0.1.5 assembles the prompt BEFORE the agent/pre-step waterfall).
   *
   * Deliberately start-less: it only binds definitions already live (the
   * engine autostarts its persisted store, so a deployment's global layer is
   * typically up before the first session). A cold definition stays cold —
   * the first session that actually installs it pays the round trip once,
   * and every later session rides the cache that install filled. Nothing is
   * started, and the one registry row a cold probe creates is released
   * again, so prewarm never changes what the engine hosts.
   */
  prewarmGlobal(): Promise<{ servers: number; tools: number }>
  /** Await in-flight release RPCs (tests; dispose has no await slot). */
  settleReleases(): Promise<void>
}

/**
 * Build a session runtime. One per host process (src/agent.ts apply());
 * tests build their own with fake supervisors/configs.
 */
export function createSessionRuntime(deps: SessionRuntimeDeps): SessionRuntime {
  const toolCallTimeoutMs = deps.toolCallTimeoutMs ?? 180000
  const ensureTimeoutMs = deps.ensureTimeoutMs ?? 60000
  /** instance -> owning sessions (host-process scope; engine is per-process). */
  const leases = new Map<string, Lease>()
  /** In-flight engine release calls, for settleReleases(). */
  const releasing = new Set<Promise<void>>()
  // Serialize setup + last-owner release for ONE definition only. A delayed
  // release must not delete a generation which a recreated context just took.
  const definitionLanes = new Map<string, Promise<unknown>>()
  function inDefinitionLane<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = definitionLanes.get(key) ?? Promise.resolve()
    const job = previous.catch(() => undefined).then(action)
    definitionLanes.set(key, job)
    const done = () => { if (definitionLanes.get(key) === job) definitionLanes.delete(key) }
    void job.then(done, done)
    return job
  }
  /** mcp.release probe result: undefined = not probed yet. */
  let releaseSupported: boolean | undefined
  /**
   * Warm install cache: defKey -> the instance + tool schemas that def
   * resolved to on the CURRENT engine child (see deps.engineEpoch). A hit
   * removes the status/ensure/tools round trips from install()'s critical
   * path, which is what lets agent-scope registration land before DSH
   * 0.1.5's first prompt assembly. Correct across workspaces by
   * construction: the engine hosts ONE instance per definition, so the same
   * def always means the same instance and the same tool list — freezing
   * them per process is exactly the per-session freeze, shared.
   */
  const warm = new Map<string, { epoch: string | undefined; instance: string; tools: SnapshotTool[] }>()
  /** Whether one warm entry still belongs to the running engine child. */
  function warmValid(entry: { epoch: string | undefined }): boolean {
    if (deps.engineEpoch === undefined) return true
    return deps.engineEpoch() === entry.epoch
  }

  function warn(line: string): void {
    deps.logger.warn('mcp-agent: ' + line)
  }

  /**
   * Whether the instance already runs on the engine. A live instance is
   * REUSED as-is: re-ensuring would route through registry.updateDef and
   * stop+replace the very instance other sessions are calling (R2).
   */
  async function instanceUsable(instance: string): Promise<boolean> {
    try {
      const status = await deps.supervisor.request('engine.status', undefined, { timeoutMs: ensureTimeoutMs }) as { mcps?: Array<{ name?: unknown; lifecycle?: unknown }> }
      const row = (status?.mcps ?? []).find((m) => m !== null && typeof m === 'object' && m.name === instance)
      if (row === undefined) return false
      return row.lifecycle === 'started' || row.lifecycle === 'idle'
    } catch {
      // Engine not ready / status failed: let ensure try and speak for itself.
      return false
    }
  }

  /**
   * Bring one instance up under its frozen def without mutating a live one.
   *
   * Answers the instance name to ADDRESS, which is not always the one asked
   * for: the engine hosts one instance per definition, so when this def is
   * already running — under another session's minted name, or under the
   * catalog name the settings panel uses — that instance is handed back and
   * this session joins it instead of starting a second copy of the same
   * server. Not a substitution: the definitions are identical by construction
   * (the engine matches on a hash of the def), which is the whole promise the
   * frozen name was there to keep. Undefined when the server cannot come up.
   */
  async function ensureInstance(server: { instance: string; def: McpDefinition; logical: string }): Promise<string | undefined> {
    if (await instanceUsable(server.instance)) return server.instance
    const ensured = await deps.supervisor.request('mcp.ensure', {
      name: server.instance,
      def: server.def,
      start: true,
    }, { timeoutMs: ensureTimeoutMs }).catch((error: unknown) => {
      // Per-entry isolation (P3.2): one bad server answers, the batch lives.
      warn('engine rejected ' + server.logical + ' (' + server.instance + '): ' + String(error instanceof Error ? error.message : error))
      return { name: server.instance, lifecycle: 'error' }
    }) as { name: string; lifecycle: string; reason?: string }
    if (ensured.lifecycle === 'error') {
      warn('engine could not start ' + server.logical + (ensured.reason !== undefined ? ' (' + ensured.reason + ')' : '') + ' — tools unavailable for this session')
      return undefined
    }
    return typeof ensured.name === 'string' && ensured.name !== '' ? ensured.name : server.instance
  }

  /** Paged tool listing under the INSTANCE name (never the logical name). */
  async function listTools(instance: string, logical: string): Promise<SnapshotTool[]> {
    const tools: SnapshotTool[] = []
    let cursor: string | undefined
    do {
      const page = await deps.supervisor.request('mcp.tools', { name: instance, cursor }, { timeoutMs: ensureTimeoutMs }) as {
        tools?: Array<{ name?: unknown; description?: unknown; inputSchema?: unknown }>
        nextCursor?: string
      }
      for (const tool of page.tools ?? []) {
        if (tool === null || typeof tool !== 'object' || typeof tool.name !== 'string') continue
        tools.push({
          name: tool.name,
          ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
          ...('inputSchema' in tool ? { inputSchema: tool.inputSchema } : {}),
        })
      }
      cursor = page.nextCursor
    } while (cursor !== undefined)
    if (tools.length > MAX_TOOLS_PER_SERVER) {
      warn(logical + ' exposes ' + String(tools.length) + ' tools; snapshot keeps the first ' + String(MAX_TOOLS_PER_SERVER))
      return tools.slice(0, MAX_TOOLS_PER_SERVER)
    }
    return tools
  }

  /**
   * Resolve one definition to its hosting instance plus tool schemas, through
   * the warm cache when it already knows this def on the CURRENT engine
   * child. Cache aside, this is exactly the old ensureInstance + listTools
   * pair; the minted name is only what the caller would open — the engine's
   * def-hash matching may answer with an instance somebody else already has
   * up, and that answer is what gets leased, addressed, and frozen.
   */
  async function resolveServer(
    def: McpDefinition,
    logical: string,
    minted: string,
  ): Promise<{ instance: string; tools: SnapshotTool[] } | undefined> {
    const key = defKeyOf(def)
    const hit = warm.get(key)
    if (hit !== undefined && warmValid(hit)) return { instance: hit.instance, tools: hit.tools }
    const instance = await ensureInstance({ instance: minted, def, logical })
    if (instance === undefined) return undefined
    const tools = await listTools(instance, logical)
    warm.set(key, { epoch: deps.engineEpoch?.(), instance, tools })
    return { instance, tools }
  }

  /** One engine call with the host-side content budget (P3.8), addressed by instance. */
  async function callEngine(instance: string, tool: string, args: unknown, exec: unknown): Promise<unknown> {    const signal = exec !== null && typeof exec === 'object' && (exec as { signal?: unknown }).signal !== undefined
      ? (exec as { signal?: unknown }).signal
      : undefined
    const result = await deps.supervisor.request('mcp.call', {
      name: instance,
      tool,
      arguments: typeof args === 'object' && args !== null ? args : {},
      timeoutMs: toolCallTimeoutMs,
    }, { timeoutMs: toolCallTimeoutMs + 10000, ...(signal !== undefined ? { signal } : {}) }) as {
      isError: boolean
      content: Array<{ type: string; text?: string }>
      structuredContent?: unknown
    }
    if (result.isError) {
      throw new Error((result.content ?? []).map((block) => block.text ?? '').join('') || 'tool call failed')
    }
    let used = 0
    const capped = (result.content ?? []).map((block) => {
      if (block.type !== 'text' || typeof block.text !== 'string') return block
      const size = Buffer.byteLength(block.text, 'utf8')
      if (used + size <= MAX_RESULT_BYTES) { used += size; return block }
      const room = Math.max(0, MAX_RESULT_BYTES - used)
      used = MAX_RESULT_BYTES
      return { ...block, text: Buffer.from(block.text, 'utf8').subarray(0, room).toString('utf8') + '\n[truncated at the 512KB session content budget]' }
    })
    return {
      content: capped,
      ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
    }
  }

  function acquire(instance: string, sessionId: string, def: McpDefinition): void {
    const lease = leases.get(instance) ?? { refs: new Map<string, number>(), definitionKey: defKeyOf(def) }
    lease.refs.set(sessionId, (lease.refs.get(sessionId) ?? 0) + 1)
    leases.set(instance, lease)
  }

  /**
   * Release one instance on the engine when its LAST lease dropped.
   *
   * CONTRACT for the parent-planned engine RPC (coordinated in final notes):
   *   mcp.release  { name: string }  ->  { released: string }
   * Stops and removes an ephemeral session instance; MUST NOT touch the
   * engine's persisted store (unlike mcp.remove, which also store-removes).
   * Unknown name => error 'unknown MCP: <name>' (treated as already gone).
   * Until it exists, this falls back to mcp.remove — safe ONLY because the
   * name was minted here and can never be a user-configured server.
   */
  function releaseOnEngine(instance: string): Promise<void> {
    const done = (async (): Promise<void> => {
      if (releaseSupported !== false) {
        try {
          await deps.supervisor.request('mcp.release', { name: instance }, { timeoutMs: ensureTimeoutMs })
          releaseSupported = true
          return
        } catch (error) {
          const code = (error as { code?: unknown }).code
          const message = error instanceof Error ? error.message : String(error)
          if (code === 'E_UNKNOWN_METHOD' || /unknown method/i.test(message)) {
            releaseSupported = false // engine build predates the RPC: use the fallback below
          } else if (/unknown MCP/i.test(message)) {
            return // engine restarted / instance already gone — nothing to do
          } else {
            warn('mcp.release failed for ' + instance + ': ' + message)
            return
          }
        }
      }
      await deps.supervisor.request('mcp.remove', { name: instance }, { timeoutMs: ensureTimeoutMs }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        if (!/unknown MCP/i.test(message)) warn('mcp.remove fallback failed for ' + instance + ': ' + message)
      })
    })().then(() => undefined, (error: unknown) => {
      warn('release of ' + instance + ' failed: ' + String(error instanceof Error ? error.message : error))
    }).finally(() => { releasing.delete(done) })
    releasing.add(done)
    return done
  }

  function release(instance: string, sessionId: string): void {
    const lease = leases.get(instance)
    if (lease === undefined) return
    const refs = lease.refs.get(sessionId) ?? 0
    if (refs === 0) return
    if (refs > 1) lease.refs.set(sessionId, refs - 1)
    else lease.refs.delete(sessionId)
    if (lease.refs.size > 0) return // other sessions still hold this generation
    const job = inDefinitionLane(lease.definitionKey, async () => {
      if (leases.get(instance) !== lease || lease.refs.size > 0) return
      leases.delete(instance)
      for (const [key, entry] of warm) if (entry.instance === instance) warm.delete(key)
      await releaseOnEngine(instance)
    })
    releasing.add(job)
    void job.then(() => releasing.delete(job), () => releasing.delete(job))
  }

  /** Register one frozen tool; the executor addresses the INSTANCE name. */
  function registerTool(
    agentCtx: ScopedContext,
    disposers: Array<() => void>,
    registered: string[],
    server: { instance: string; logical: string },
    tool: SnapshotTool,
    unavailable = false,
  ): void {
    const publicName = publicNameLite(server.logical, tool.name)
    disposers.push(agentCtx.tools.register({
      name: publicName,
      description: tool.description ?? '',
      parameters: tool.inputSchema,
      output: createOutputLite(tool.name),
      execute: async (args, exec) => {
        if (unavailable) throw Object.assign(new Error('Frozen MCP ' + server.logical + ' is unavailable in this conversation'), { code: 'E_MCP_UNAVAILABLE' })
        return await callEngine(server.instance, tool.name, args, exec)
      },
    }))
    registered.push(publicName)
  }

  /** Wire tool disposers + lease release to the agent scope's lifetime. */
  function attachLifecycle(agentCtx: ScopedContext, instances: string[], sessionId: string, disposers: Array<() => void>): void {
    agentCtx.effect(() => () => {
      for (const dispose of disposers) dispose()
      for (const instance of instances) release(instance, sessionId)
    }, 'mcp-agent.session-tools')
  }

  /** Replay a frozen generation: engine instances from the snapshot def, tools from the snapshot schemas. */
  async function restoreFromSnapshot(
    agentCtx: ScopedContext,
    sessionId: string,
    snapshot: SessionSnapshot,
  ): Promise<InstallSummary> {
    const registered: string[] = []
    const disposers: Array<() => void> = []
    const unavailable: string[] = []
    const instances: string[] = []
    for (const server of snapshot.servers) {
      // Frozen def, frozen instance name — never the current preview. A
      // server that cannot come back is unavailable; no substitution (R3).
      const instance = await inDefinitionLane(defKeyOf(server.def), async () => {
        const found = await ensureInstance({ instance: server.instance, def: server.def, logical: server.logical })
        if (found !== undefined) acquire(found, sessionId, server.def)
        return found
      })
      if (instance === undefined) {
        unavailable.push(server.logical)
        // Keep the exact frozen descriptors even when that generation cannot
        // return. The body fails locally; it never addresses a replacement.
        for (const tool of server.tools) registerTool(agentCtx, disposers, registered, server, tool, true)
        continue
      }
      // The lease and every tool call address what the engine answered, not
      // what the snapshot froze: joining a live instance of the same
      // definition is the point, and a lease on a name nothing hosts would
      // never be released.
      instances.push(instance)
      for (const tool of server.tools) {
        registerTool(agentCtx, disposers, registered, { ...server, instance }, tool)
      }
    }
    if (disposers.length > 0 || instances.length > 0) attachLifecycle(agentCtx, instances, sessionId, disposers)
    return { restored: true, servers: snapshot.servers.length, tools: registered.length, unavailable }
  }

  /** Compute a fresh generation from the merged preview and freeze it. */
  async function installFresh(
    agentCtx: ScopedContext,
    sessionId: string,
    workspaceId: string,
    snapshotPath: string,
  ): Promise<InstallSummary> {
    const preview = await deps.config.preview({ workspaceId, sessionId, maskSecrets: false })
    const active = preview.entries.filter((entry) => !entry.disabled)
    const registered: string[] = []
    const disposers: Array<() => void> = []
    const unavailable: string[] = []
    const instances: string[] = []
    const servers: SessionSnapshotServer[] = []

    for (const entry of active.slice(0, MAX_SERVERS_PER_SNAPSHOT)) {
      // The engine speaks its OWN def dialect: native entries ride as-is;
      // standard entries convert (command->proc, url->http); anything else
      // (a malformed survivor) is skipped loudly for this session. The def
      // below is DATA for the engine — nothing here executes commands.
      let def = entry.def
      if (entry.source === 'standard') {
        const converted = standardToNative(entry.def)
        if (converted === undefined) {
          warn('standard entry ' + entry.name + ' has no engine carrier; skipped')
          unavailable.push(entry.name)
          continue
        }
        def = converted as McpDefinition
      }
      // The minted name is what this session would OPEN; the engine answers
      // with what it actually hosts for this definition, which may be an
      // instance another session (or the settings panel) already has up —
      // and if the warm cache already resolved this def on this engine
      // child, no round trip happens at all (see resolveServer).
      const minted = instanceNameFor(workspaceId, entry.name, def)
      const resolved = await inDefinitionLane(defKeyOf(def), async () => {
        const found = await resolveServer(def, entry.name, minted)
        if (found !== undefined) acquire(found.instance, sessionId, def)
        return found
      })
      if (resolved === undefined) {
        unavailable.push(entry.name)
        continue
      }
      const { instance, tools } = resolved
      instances.push(instance)
      servers.push({ logical: entry.name, instance, def, tools })
      // Do not publish descriptors before winning the immutable snapshot CAS.
    }

    // Freeze the generation ONCE. A lost race with another writer (the
    // per-path lock serializes file access) keeps the existing snapshot.
    const snapshot: SessionSnapshot = {
      version: 2,
      workspaceId,
      registeredAt: new Date().toISOString(),
      configRevision: configRevisionOf(preview),
      servers,
    }
    let written: Awaited<ReturnType<typeof writeSnapshotImmutable>>
    try { written = await writeSnapshotImmutable(snapshotPath, snapshot) }
    catch (error) {
      for (const instance of instances) release(instance, sessionId)
      throw error
    }
    if (!written.wrote) {
      for (const instance of instances) release(instance, sessionId)
      if (isRestorableSnapshot(written.current)) return await restoreFromSnapshot(agentCtx, sessionId, written.current)
      throw Object.assign(new Error('Cannot persist an immutable MCP snapshot for session ' + sessionId), { code: 'E_SNAPSHOT_UNAVAILABLE' })
    }
    for (const server of servers) for (const tool of server.tools) registerTool(agentCtx, disposers, registered, server, tool)
    if (disposers.length > 0 || instances.length > 0) attachLifecycle(agentCtx, instances, sessionId, disposers)
    if (active.length > MAX_SERVERS_PER_SNAPSHOT) {
      warn('workspace has ' + String(active.length) + ' active servers; snapshot keeps ' + String(MAX_SERVERS_PER_SNAPSHOT))
    }
    return { restored: false, servers: servers.length, tools: registered.length, unavailable }
  }

  return {
    async install(agentCtx, sessionId, workspaceId) {
      const path = sessionFilePath(deps.storageDir, sessionId)
      const { file, problem } = await readSessionFile(path)
      if (problem !== undefined || (file.snapshot !== undefined && !isRestorableSnapshot(file.snapshot))) {
        // Existing but unreadable/legacy generations must never adopt today's
        // config. Missing definitions cannot be honestly reconstructed.
        throw Object.assign(new Error('Cannot safely restore the MCP snapshot for session ' + sessionId), { code: 'E_SNAPSHOT_UNAVAILABLE' })
      }
      if (isRestorableSnapshot(file.snapshot)) {
        return await restoreFromSnapshot(agentCtx, sessionId, file.snapshot)
      }
      return await installFresh(agentCtx, sessionId, workspaceId, path)
    },
    workspaceIdOf(input) {
      return deps.workspaceIdOf !== undefined ? deps.workspaceIdOf(input) : canonicalWorkspaceId(input.cwd)
    },
    async prewarmGlobal() {
      // Global-only view: preview without a workspaceId skips every project
      // layer (session layers need a session). Standard entries convert to
      // the engine dialect exactly as installFresh does — same defs, same
      // cache keys, so a prewarmed entry is a HIT for the first session.
      const preview = await deps.config.preview({ maskSecrets: false })
      const active = preview.entries.filter((entry) => !entry.disabled).slice(0, MAX_SERVERS_PER_SNAPSHOT)
      let servers = 0
      let tools = 0
      for (const entry of active) {
        let def = entry.def
        if (entry.source === 'standard') {
          const converted = standardToNative(entry.def)
          if (converted === undefined) continue
          def = converted as McpDefinition
        }
        try {
          const key = defKeyOf(def)
          const hit = warm.get(key)
          if (hit !== undefined && warmValid(hit)) {
            servers += 1
            tools += hit.tools.length
            continue
          }
          // The minted name is a placeholder nobody leases: the engine's
          // def-hash matching answers with the instance already hosting this
          // definition (often the panel's own live one), and that answer —
          // not the placeholder — is what the cache binds and sessions lease.
          const minted = instanceNameFor('__prewarm__', entry.name, def)
          const reply = await deps.supervisor.request('mcp.ensure', { name: minted, def, start: false }, { timeoutMs: ensureTimeoutMs }) as {
            name?: unknown
            lifecycle?: unknown
            reused?: boolean
          }
          const instance = typeof reply.name === 'string' && reply.name !== '' ? reply.name : minted
          // Only a LIVE twin is warmable: a stopped/error row answers
          // tools/list with nothing (or spawns a lazy proc, which prewarm
          // must not do). 'idle' is a lazy proc's resting state — list would
          // SPAWN it — so 'started' only.
          if (reply.lifecycle !== 'started' || instance === minted) {
            // A row this probe itself created goes away again: prewarm must
            // leave the engine hosting exactly what it hosted before. A twin
            // somebody else owns (instance !== minted) is never touched. The
            // cleanup is AWAITED — prewarmGlobal resolves only once the
            // engine is back to where it started, which is what lets every
            // session install safely run behind it.
            if (instance === minted && reply.reused !== true) await releaseOnEngine(minted)
            continue
          }
          const listed = await listTools(instance, entry.name)
          warm.set(key, { epoch: deps.engineEpoch?.(), instance, tools: listed })
          servers += 1
          tools += listed.length
        } catch (error) {
          // Per-entry isolation: a broken global server must not block the
          // rest, and must not fail activation (a session retries the def
          // through the uncached path when it actually installs).
          warn('prewarm of ' + entry.name + ' failed: ' + String(error instanceof Error ? error.message : error))
        }
      }
      return { servers, tools }
    },
    async settleReleases() {
      await Promise.all([...releasing])
    },
  }
}
