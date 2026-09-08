/**
 * Session mode: the per-workspace bridge over the MCP SDK. With
 * 'project: session' the host mounts only the global layer; every agent
 * instead gets ITS workspace's project servers registered into that agent's
 * own scope, so sessions see exactly their project's servers (plus the
 * global ones). Connections are shared per project directory, and this
 * bridge talks the MCP protocol directly, so the global mcp-client
 * name-uniqueness check does not apply.
 *
 * The SDK client's result shapes are consumed defensively (loose types):
 * they mirror what mcp-client's executor checks at the same seams.
 *
 * @module dsh-mcp-adapter/session
 */

import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { planServers } from './plan.js'
import type { McpSdk } from './loader.js'
import type { Context, ScopedContext } from './cordis.js'

/** Adapter options the session bridge consults. */
export interface SessionOptions {
  disable: Set<string>
  toolCallTimeoutMs?: number
}

/** One connected server as projectServersFor returns it. */
export interface ConnectedServer {
  name: string
  holder: Holder
}

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
export function extractTextLite(content: unknown[]): string {
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
export interface OutputTextElement {
  type: 'text'
  text: string
}

/** The output descriptor shape for one bridged tool (mcp-client's shape). */
export interface ToolOutput {
  schema: Record<string, unknown>
  render: (args: unknown, value: unknown) => OutputTextElement[]
}

/**
 * Create the output descriptor for one bridged tool (mcp-client's shape).
 * @param rawName - the MCP tool name, for render fallbacks.
 */
export function createOutputLite(rawName: string): ToolOutput {
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

/** The live SDK client handle (its dynamic surface is checked defensively). */
type AnyClient = any

/**
 * One shared server connection with single-flight reconnect. The holder owns
 * the live SDK client and rebuilds it (fresh transport + client, same config)
 * when the transport closes — an HTTP MCP gateway restarting mid-session is
 * the normal case this serves. The registered tool set never changes (load
 * time only); only the underlying connection is healed, lazily, on the next
 * call or the next session's listing.
 */
export interface Holder {
  /** the live SDK client (null only before the first connect) */
  client: AnyClient
  /** whether the transport has closed */
  dead: boolean
  /** the in-flight (re)connect attempt, shared by concurrent callers */
  pending?: Promise<AnyClient>
  /** return a live client, (re)connecting single-flight when needed */
  ensure(): Promise<AnyClient>
  /** list tools, healing the connection on a closure error */
  list(cursor?: string): Promise<any>
  /** call a tool, healing the connection on a closure error */
  call(rawName: string, args: Record<string, unknown>, signal: unknown, timeoutMs: number): Promise<any>
}

/**
 * Whether an error is a transport-level closure (MCP ErrorCode.ConnectionClosed
 * is -32000; the message match covers an SDK copy whose class identity differs).
 * @param error - a thrown value from a client request.
 * @returns true when the failure is a closed connection, not a tool-level error.
 */
export function isConnectionError(error: unknown): boolean {
  if (error !== null && typeof error === 'object' && (error as { code?: unknown }).code === -32000) return true
  const message = error !== null && typeof error === 'object' ? (error as { message?: unknown }).message : undefined
  return /connection closed|not connected|transport closed|fetch failed/i.test(String(message ?? error ?? ''))
}

/**
 * Run one request against the holder's client, reconnecting once and retrying
 * when the failure is a closed connection. Tool-level errors pass through
 * untouched on the first attempt.
 * @param holder - the connection holder.
 * @param run - the request thunk.
 * @returns the request result.
 */
async function withRetry(holder: Holder, run: (client: AnyClient) => Promise<any>): Promise<any> {
  let client = holder.client
  if (client === null || holder.dead) client = await holder.ensure()
  try {
    return await run(client)
  } catch (error) {
    if (!isConnectionError(error)) throw error
    const reconnected = await holder.ensure()
    return await run(reconnected)
  }
}

/**
 * Connection holders per SERVER CONFIGURATION (sha256 of the transport
 * spec), shared by every session whose project file declares that exact
 * config. Module-level so adapter HMR reloads do not spawn duplicate servers;
 * a config change produces a new key, so the next session reconnects while
 * unchanged servers keep their holder.
 */
const clientByConfig = new Map<string, Promise<Holder>>()

/**
 * Stable identity of one mcp-client config for connection sharing.
 * @param config - one planned server config.
 * @returns a sha256 hex digest of the transport-defining fields.
 */
export function configKey(config: Record<string, unknown>): string {
  const identity = config.transport === 'stdio'
    ? ['stdio', config.command, config.args, config.env, config.cwd]
    : ['http', config.url, config.headers]
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex')
}

/**
 * Build a reconnecting holder for one server config.
 * @param config - one planned server config.
 * @param sdk - resolved SDK constructors.
 * @returns the holder; call {@link Holder.ensure} to connect.
 */
export function createHolder(config: Record<string, unknown>, sdk: McpSdk): Holder {
  const holder: Holder = {
    client: null,
    dead: false,
    pending: undefined,
    ensure() {
      if (holder.client !== null && !holder.dead) return Promise.resolve(holder.client)
      holder.pending ??= (async () => {
        try {
          const transport = config.transport === 'stdio'
            ? new sdk.StdioClientTransport({
              command: config.command as string,
              args: config.args as string[],
              env: { ...scrubbedEnvLite(), ...(config.env as Record<string, string>) },
              cwd: config.cwd as string,
            })
            : new sdk.StreamableHTTPClientTransport(new URL(config.url as string), { requestInit: { headers: config.headers as Record<string, string> } })
          const client = new sdk.Client({ name: 'dsh-mcp-json-adapter', version: '1.0.0' }, { capabilities: {} })
          client.onclose = () => { holder.dead = true }
          await client.connect(transport)
          holder.client = client
          holder.dead = false
          return client
        } finally {
          // Success or failure, the slot clears: later callers reuse the live
          // client directly, or start a fresh attempt after a failure.
          holder.pending = undefined
        }
      })()
      return holder.pending
    },
    list(cursor?: string) {
      return withRetry(holder, (client) => client.listTools(cursor === undefined ? {} : { cursor }))
    },
    call(rawName: string, args: Record<string, unknown>, signal: unknown, timeoutMs: number) {
      return withRetry(holder, (client) => client.callTool({ name: rawName, arguments: args }, undefined, {
        signal,
        timeout: timeoutMs,
        resetTimeoutOnProgress: true,
      }))
    },
  }
  return holder
}

/**
 * Connect (or reuse) one server config's holder.
 * @param config - one planned server config.
 * @param sdk - resolved SDK constructors.
 * @returns the connected holder.
 */
export function clientFor(config: Record<string, unknown>, sdk: McpSdk): Promise<Holder> {
  const key = configKey(config)
  const existing = clientByConfig.get(key)
  if (existing !== undefined) return existing
  const holder = createHolder(config, sdk)
  const ready = holder.ensure().then(() => holder)
  clientByConfig.set(key, ready)
  // A failed INITIAL connect must not be served to later sessions; a settled
  // holder stays cached even after a later death, because ensure() heals it.
  ready.catch(() => clientByConfig.delete(key))
  return ready
}

/**
 * Plan and connect the servers one project directory declares, re-reading
 * the layer files on every call so each NEW session sees the current file.
 * Per-server failures are contained: the server is skipped with an error log.
 * @param cwd - the session workspace directory.
 * @param sdk - resolved SDK constructors.
 * @param resolved - adapter options.
 * @param ctx - plugin context for logging.
 * @returns the connected servers.
 */
export async function projectServersFor(cwd: string, sdk: McpSdk, resolved: SessionOptions, ctx: Context): Promise<ConnectedServer[]> {
  const perProject = {
    projectRoot: cwd,
    disable: resolved.disable,
    failOnStartupError: false,
    ...(resolved.toolCallTimeoutMs !== undefined ? { toolCallTimeoutMs: resolved.toolCallTimeoutMs } : {}),
  }
  const files = [join(cwd, '.mcp.json'), join(cwd, '.agents', '.mcp.json')]
  const plan = await planServers(perProject, files, (line) => ctx.logger.warn(line))
  const connected: ConnectedServer[] = []
  for (const config of plan.configs) {
    const name = config.serverName as string
    try {
      const holder = await clientFor(config, sdk)
      connected.push({ name, holder })
    } catch (error) {
      ctx.logger.error('mcp-json-adapter: session server "' + name + '" (' + cwd + ') failed to connect: ' + String(error instanceof Error ? error.message : error))
    }
  }
  return connected
}

/**
 * Minimal ambient-env scrub for stdio children: drop credential-shaped and
 * DSH_ names, mirroring what the harness subprocess seam does for mcp-client.
 * @returns the scrubbed environment.
 */
export function scrubbedEnvLite(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (key.startsWith('DSH_')) continue
    if (/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/.test(key)) continue
    out[key] = value
  }
  return out
}

/**
 * Create the execute function for one bridged tool; mirrors mcp-client's
 * executor semantics (isError throws, non-object args fall back to {}). The
 * request goes through the holder, which heals the connection and retries
 * once when the transport closed (e.g. the HTTP MCP gateway restarted).
 * @param holder - the server's reconnecting connection holder.
 * @param rawName - the MCP tool name sent on the wire.
 * @param timeoutMs - per-call timeout.
 * @returns the executor.
 */
export function createExecutorLite(holder: Holder, rawName: string, timeoutMs: number): (args: unknown, exec: unknown) => Promise<object> {
  return async (args, exec) => {
    const argsObj = typeof args === 'object' && args !== null ? args as Record<string, unknown> : {}
    const signal = exec !== null && typeof exec === 'object' && (exec as { signal?: unknown }).signal !== undefined ? (exec as { signal?: unknown }).signal : undefined
    const result = await holder.call(rawName, argsObj, signal, timeoutMs)
    if (!Array.isArray(result.content)) {
      const rendered = 'toolResult' in result ? JSON.stringify((result as Record<string, unknown>).toolResult) : '(no output)'
      const text = typeof rendered === 'string' ? rendered : '(no output)'
      if (result.isError === true) throw new Error(text)
      return {
        content: [{ type: 'text', text }],
        ...((result as Record<string, unknown>).structuredContent !== undefined ? { structuredContent: (result as Record<string, unknown>).structuredContent } : {}),
      }
    }
    if (result.isError === true) {
      throw new Error(extractTextLite(result.content))
    }
    return {
      content: result.content,
      ...((result as Record<string, unknown>).structuredContent !== undefined ? { structuredContent: (result as Record<string, unknown>).structuredContent } : {}),
    }
  }
}

/**
 * Register one workspace's MCP tools into an agent's scoped context. Tools
 * file into that agent's scope layer only; the shared per-project clients
 * stay at host level. Registrations ride the agent fiber for disposal.
 * @param agentCtx - the agent's scoped context.
 * @param cwd - the session workspace directory.
 * @param sdk - resolved SDK constructors.
 * @param resolved - adapter options.
 * @param ctx - plugin context for logging.
 * @returns how many tools were registered.
 */
export async function installWorkspaceTools(agentCtx: ScopedContext, cwd: string, sdk: McpSdk, resolved: SessionOptions, ctx: Context): Promise<number> {
  const servers = await projectServersFor(cwd, sdk, resolved, ctx)
  if (servers.length === 0) return 0
  const timeoutMs = resolved.toolCallTimeoutMs ?? 60000
  const disposers: Array<() => void> = []
  let count = 0
  // Register through the agent's own scoped context: the agent loop's
  // inject list makes 'tools' resolvable there, and the context's scope tag
  // files each registration into THIS agent's layer (the same pattern the
  // harness's scoped tool tests and preset compositions use).
  for (const server of servers) {
    let cursor: string | undefined
    do {
      const page = await server.holder.list(cursor)
      for (const tool of page.tools) {
        const publicName = publicNameLite(server.name, tool.name)
        disposers.push(agentCtx.tools.register({
          name: publicName,
          description: tool.description ?? '',
          parameters: tool.inputSchema,
          output: createOutputLite(tool.name),
          execute: createExecutorLite(server.holder, tool.name, timeoutMs),
        }))
        count += 1
      }
      cursor = page.nextCursor
    } while (cursor)
  }
  if (count > 0) {
    agentCtx.effect(() => () => {
      for (const dispose of disposers) dispose()
    }, 'mcp-json-adapter.session-tools')
    ctx.logger.info('mcp-json-adapter: session workspace ' + cwd + ' mounted ' + String(count) + ' tool(s) from ' + String(servers.length) + ' server(s)')
  }
  return count
}
