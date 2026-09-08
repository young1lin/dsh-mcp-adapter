/**
 * local-mcp-gateway discovery layer for the adapter.
 *
 * The gateway (github.com/young1lin/local-mcp-gateway) hosts every MCP this
 * machine needs ONCE behind 'http://127.0.0.1:19999/<name>' paths: databases
 * in-process, stdio servers as lazy 'proc' children, remote MCPs proxied.
 * Its panel (or 'managed.json') is the natural single source of truth for
 * which MCPs exist — so instead of hand-copying every gateway MCP into a
 * '.mcp.json' entry (the previous workflow, with the bearer token pasted in
 * plaintext), this layer ASKS the gateway what it hosts and mounts that.
 *
 * Surface used (all loopback-bound by the gateway itself; '/api' has no
 * credential check beyond the loopback guard, MCP endpoints stay gated):
 *   GET  /health               -> { ok: true }
 *   GET  /api/mcps             -> { mcps: [{ name, description, type,
 *                                            lifecycle, state, group, ... }] }
 *   GET  /api/tokens           -> { tokens: [{ id, label, createdAt }] }
 *   POST /api/tokens {label}   -> { id, label, secret, createdAt }
 *   GET  /api/tokens/:id/secret-> { id, label, secret }
 *   POST /<name> + Bearer      -> the MCP streamable-http endpoint
 *
 * Bearer token resolution order (first hit wins):
 *   1. explicit 'token' in adapter config
 *   2. the MACHINE-SEALED store (see './sealed.ts')
 *   3. process environment 'tokenEnv' (default MCP_GATEWAY_TOKEN)
 *   4. a token labeled 'tokenLabel' (default 'dsh'); created on first use
 *      when 'createToken' (default true) — so dsh traffic is attributed to
 *      its own revocable token in the gateway's call log
 *
 * @module dsh-mcp-adapter/gateway
 */

import { spawn } from 'node:child_process'
import { openSecret } from './sealed.js'
import { SERVER_NAME_PATTERN } from './shared.js'

/** Default gateway base URL; the gateway refuses non-loopback binds anyway. */
export const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:19999'

/** Sub-keys accepted inside the adapter's 'gateway' config block. */
const GATEWAY_KEYS = new Set(['url', 'groups', 'include', 'exclude', 'token', 'tokenEnv', 'tokenLabel', 'createToken', 'autostart', 'required', 'fetchTimeoutMs', 'embed'])

/** Sub-keys accepted inside 'gateway.embed'. */
const EMBED_KEYS = new Set(['entry', 'respawn', 'leaveRunning', 'startupTimeoutMs'])

/** Sub-keys accepted inside 'gateway.autostart'. */
const AUTOSTART_KEYS = new Set(['command', 'args', 'timeoutMs'])

/** Legacy one-shot start command ('true' = the 'lmg start' recipe). */
export interface AutostartConfig {
  command: string
  args: string[]
  timeoutMs: number
}

/** Embedded-lifecycle options (the plugin OWNS the gateway process). */
export interface EmbedConfig {
  entry?: string
  respawn: boolean
  leaveRunning: boolean
  startupTimeoutMs?: number
}

/** The resolved 'gateway' config block (null when the layer is off). */
export interface GatewayConfig {
  url: string
  groups: string[]
  include: string[]
  exclude: string[]
  token?: string
  tokenEnv: string
  tokenLabel: string
  createToken: boolean
  autostart: AutostartConfig | null
  embed: EmbedConfig | null
  required: boolean
  fetchTimeoutMs: number
}

/** Subset of GatewayConfig the bearer-token chain consults. */
export interface TokenResolutionConfig {
  url: string
  token?: string
  tokenEnv: string
  tokenLabel: string
  createToken: boolean
  fetchTimeoutMs: number
}

/** Subset of GatewayConfig the discovery call consults. */
export interface DiscoveryConfig {
  url: string
  groups: string[]
  include: string[]
  exclude: string[]
  fetchTimeoutMs: number
}

/** One discovered MCP mapped onto an mcp-client config. */
export interface DiscoveredServer {
  serverName: string
  transport: 'streamable-http'
  url: string
  headers: { Authorization: string }
  /** adapter-level options forwarded onto every mounted server */
  failOnStartupError?: boolean
  toolCallTimeoutMs?: number
  /** mcp-client consumes configs as open bags; keep this one open too */
  [key: string]: unknown
}

/** Result of one discovery round. */
export interface GatewayPlan {
  configs: DiscoveredServer[]
  skipped: string[]
}

/**
 * Validate the 'gateway' config block.
 * @param raw - the block's value ('true' means all defaults).
 * @returns the resolved gateway config, or null when no block was given
 *   (the layer is opt-in).
 * @throws on unknown keys or wrongly typed values.
 */
export function resolveGatewayConfig(raw: unknown): GatewayConfig | null {
  if (raw === undefined || raw === null || raw === false) return null
  const config = raw === true ? {} : raw
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('mcp-json-adapter: gateway config must be an object (or true)')
  }
  for (const key of Object.keys(config as Record<string, unknown>)) {
    if (!GATEWAY_KEYS.has(key)) throw new Error('mcp-json-adapter: unknown gateway config key "' + key + '"')
  }
  const cfg = config as Record<string, unknown>
  let url = DEFAULT_GATEWAY_URL
  if (cfg.url !== undefined) {
    if (typeof cfg.url !== 'string' || cfg.url.length === 0) {
      throw new Error('mcp-json-adapter: gateway.url must be a non-empty string')
    }
    try {
      url = new URL(cfg.url).origin
    } catch {
      throw new Error('mcp-json-adapter: gateway.url is not a valid URL: ' + String(cfg.url))
    }
  }
  for (const [key, pattern] of [['groups', 'gateway.groups'], ['include', 'gateway.include'], ['exclude', 'gateway.exclude']] as const) {
    if (cfg[key] !== undefined && (!Array.isArray(cfg[key]) || (cfg[key] as unknown[]).some((v) => typeof v !== 'string'))) {
      throw new Error('mcp-json-adapter: ' + pattern + ' must be an array of strings')
    }
  }
  if (cfg.token !== undefined && typeof cfg.token !== 'string') {
    throw new Error('mcp-json-adapter: gateway.token must be a string')
  }
  if (cfg.tokenEnv !== undefined && (typeof cfg.tokenEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(cfg.tokenEnv as string))) {
    throw new Error('mcp-json-adapter: gateway.tokenEnv must be an environment variable name')
  }
  if (cfg.tokenLabel !== undefined && typeof cfg.tokenLabel !== 'string') {
    throw new Error('mcp-json-adapter: gateway.tokenLabel must be a string')
  }
  if (cfg.createToken !== undefined && typeof cfg.createToken !== 'boolean') {
    throw new Error('mcp-json-adapter: gateway.createToken must be a boolean')
  }
  if (cfg.required !== undefined && typeof cfg.required !== 'boolean') {
    throw new Error('mcp-json-adapter: gateway.required must be a boolean')
  }
  if (cfg.fetchTimeoutMs !== undefined && (typeof cfg.fetchTimeoutMs !== 'number' || !Number.isFinite(cfg.fetchTimeoutMs) || (cfg.fetchTimeoutMs as number) <= 0)) {
    throw new Error('mcp-json-adapter: gateway.fetchTimeoutMs must be a positive finite number')
  }
  let embed: EmbedConfig | null = null
  if (cfg.embed !== undefined && cfg.embed !== false) {
    const block = cfg.embed === true ? {} : cfg.embed
    if (typeof block !== 'object' || Array.isArray(block)) {
      throw new Error('mcp-json-adapter: gateway.embed must be an object (or true)')
    }
    for (const key of Object.keys(block as Record<string, unknown>)) {
      if (!EMBED_KEYS.has(key)) throw new Error('mcp-json-adapter: unknown gateway.embed key "' + key + '"')
    }
    const b = block as Record<string, unknown>
    if (b.entry !== undefined && (typeof b.entry !== 'string' || (b.entry as string).length === 0)) {
      throw new Error('mcp-json-adapter: gateway.embed.entry must be a non-empty path')
    }
    if (b.respawn !== undefined && typeof b.respawn !== 'boolean') {
      throw new Error('mcp-json-adapter: gateway.embed.respawn must be a boolean')
    }
    if (b.leaveRunning !== undefined && typeof b.leaveRunning !== 'boolean') {
      throw new Error('mcp-json-adapter: gateway.embed.leaveRunning must be a boolean')
    }
    if (b.startupTimeoutMs !== undefined && (typeof b.startupTimeoutMs !== 'number' || !Number.isFinite(b.startupTimeoutMs) || (b.startupTimeoutMs as number) <= 0)) {
      throw new Error('mcp-json-adapter: gateway.embed.startupTimeoutMs must be a positive finite number')
    }
    embed = {
      ...(b.entry !== undefined ? { entry: b.entry as string } : {}),
      respawn: b.respawn === undefined ? true : b.respawn as boolean,
      leaveRunning: b.leaveRunning === undefined ? false : b.leaveRunning as boolean,
      ...(b.startupTimeoutMs !== undefined ? { startupTimeoutMs: b.startupTimeoutMs as number } : {}),
    }
  }
  let autostart: AutostartConfig | null = null
  if (cfg.autostart !== undefined && cfg.autostart !== false) {
    const block = cfg.autostart === true ? {} : cfg.autostart
    if (typeof block !== 'object' || Array.isArray(block)) {
      throw new Error('mcp-json-adapter: gateway.autostart must be an object (or true for the lmg default)')
    }
    for (const key of Object.keys(block as Record<string, unknown>)) {
      if (!AUTOSTART_KEYS.has(key)) throw new Error('mcp-json-adapter: unknown gateway.autostart key "' + key + '"')
    }
    const b = block as Record<string, unknown>
    let command = 'npx'
    let args = ['-y', 'local-mcp-gateway', 'start']
    if (b.command !== undefined) {
      if (typeof b.command !== 'string' || (b.command as string).length === 0) {
        throw new Error('mcp-json-adapter: gateway.autostart.command must be a non-empty string')
      }
      command = b.command as string
      args = []
    }
    if (b.args !== undefined) {
      if (!Array.isArray(b.args) || (b.args as unknown[]).some((v) => typeof v !== 'string')) {
        throw new Error('mcp-json-adapter: gateway.autostart.args must be an array of strings')
      }
      args = b.args as string[]
    }
    let timeoutMs = 20000
    if (b.timeoutMs !== undefined) {
      if (typeof b.timeoutMs !== 'number' || !Number.isFinite(b.timeoutMs) || (b.timeoutMs as number) <= 0) {
        throw new Error('mcp-json-adapter: gateway.autostart.timeoutMs must be a positive finite number')
      }
      timeoutMs = b.timeoutMs as number
    }
    autostart = { command, args, timeoutMs }
  }
  return {
    url,
    groups: cfg.groups === undefined ? [] : (cfg.groups as string[]),
    include: cfg.include === undefined ? [] : (cfg.include as string[]),
    exclude: cfg.exclude === undefined ? [] : (cfg.exclude as string[]),
    token: cfg.token as string | undefined,
    tokenEnv: cfg.tokenEnv === undefined ? 'MCP_GATEWAY_TOKEN' : (cfg.tokenEnv as string),
    tokenLabel: cfg.tokenLabel === undefined ? 'dsh' : (cfg.tokenLabel as string),
    createToken: cfg.createToken === undefined ? true : (cfg.createToken as boolean),
    autostart,
    embed,
    required: cfg.required === undefined ? false : (cfg.required as boolean),
    fetchTimeoutMs: cfg.fetchTimeoutMs === undefined ? 5000 : (cfg.fetchTimeoutMs as number),
  }
}

/** Options for one gateway HTTP request. */
export interface GatewayFetchOptions {
  method?: string
  body?: unknown
  timeoutMs: number
}

/** A gateway response with best-effort parsed JSON. */
export interface GatewayResponse {
  status: number
  json: unknown
}

/**
 * One gateway HTTP request with a timeout.
 * @param url - absolute URL.
 * @param opts - method/body/timeout.
 * @returns the parsed response.
 * @throws on network failure or timeout.
 */
export async function gatewayFetch(url: string, opts: GatewayFetchOptions): Promise<GatewayResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
  timer.unref()
  try {
    const response = await fetch(url, {
      method: opts.method ?? 'GET',
      signal: controller.signal,
      headers: opts.body === undefined ? {} : { 'content-type': 'application/json' },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    })
    let json: unknown
    try {
      json = await response.json()
    } catch {
      json = undefined
    }
    return { status: response.status, json }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Whether the gateway answers on /health.
 * @param base - gateway origin.
 * @param timeoutMs - probe timeout.
 */
export async function probeHealth(base: string, timeoutMs: number): Promise<boolean> {
  try {
    const { status, json } = await gatewayFetch(base + '/health', { timeoutMs })
    return status === 200 && json !== undefined && (json as { ok?: boolean }).ok === true
  } catch {
    return false
  }
}

/** Config shape ensureGatewayRunning consults. */
export interface EnsureRunningConfig {
  url: string
  autostart: AutostartConfig | null
  fetchTimeoutMs: number
}

/**
 * Make sure the gateway is up, autostarting it when configured.
 * 'autostart.command' runs detached (the gateway daemonizes itself — 'lmg
 * start' returns once /health answers), then health is polled until the
 * timeout. A start command that exits nonzero still gets the poll window:
 * a race with an instance started by another client is a success, not an
 * error.
 * @param resolved - resolved gateway config.
 * @param log - info sink.
 * @returns whether /health answers afterwards.
 */
export async function ensureGatewayRunning(resolved: EnsureRunningConfig, log: (line: string) => void): Promise<boolean> {
  if (await probeHealth(resolved.url, resolved.fetchTimeoutMs)) return true
  const autostart = resolved.autostart
  if (autostart === null) return false
  log('mcp-json-adapter: gateway not reachable at ' + resolved.url + '; starting: ' + autostart.command + ' ' + autostart.args.join(' '))
  try {
    await new Promise<void>((resolvePromise) => {
      const child = spawn(autostart.command, autostart.args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      child.on('error', () => resolvePromise())
      child.on('exit', () => resolvePromise())
      const guard = setTimeout(() => resolvePromise(), autostart.timeoutMs)
      guard.unref()
    })
  } catch (error) {
    log('mcp-json-adapter: gateway start command failed: ' + String(error instanceof Error ? error.message : error))
  }
  const deadline = Date.now() + autostart.timeoutMs
  while (Date.now() < deadline) {
    if (await probeHealth(resolved.url, 1000)) return true
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 500))
  }
  return await probeHealth(resolved.url, 1000)
}

/** Name of the machine-bound token slot inside the sealed store. */
const SEALED_TOKEN_NAME = 'gateway-token'

/**
 * Resolve the bearer token for MCP endpoints. Order: explicit config token,
 * the MACHINE-SEALED store (see './sealed.ts' - a copied file is ciphertext on
 * any other machine), the process environment, then the gateway itself (the
 * label-named token, auto-created on first use). The auto-issued token is
 * deliberately NOT sealed back: a later rotate on the gateway must heal on
 * the next host restart instead of pinning a stale secret.
 * @param resolved - resolved gateway config.
 * @returns the bearer secret.
 * @throws when no resolution path yields a token.
 */
export async function resolveBearerToken(resolved: TokenResolutionConfig): Promise<string> {
  if (resolved.token !== undefined) return resolved.token
  const sealed = openSecret(SEALED_TOKEN_NAME)
  if (sealed !== undefined && sealed.length > 0) return sealed
  const fromEnv = process.env[resolved.tokenEnv]
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
  const { status, json } = await gatewayFetch(resolved.url + '/api/tokens', { timeoutMs: resolved.fetchTimeoutMs })
  if (status !== 200 || json === null || typeof json !== 'object' || !Array.isArray((json as { tokens?: unknown }).tokens)) {
    throw new Error('gateway /api/tokens answered ' + String(status))
  }
  /** @type {{ id: string, label: string }[]} */
  const tokens = (json as { tokens: Array<{ id: string; label: string }> }).tokens
  const wanted = tokens.find((row) => row.label === resolved.tokenLabel)
  if (wanted !== undefined) {
    const secret = await fetchSecret(resolved, wanted.id)
    if (secret !== undefined) return secret
  }
  if (resolved.createToken && wanted === undefined) {
    const created = await gatewayFetch(resolved.url + '/api/tokens', {
      method: 'POST',
      body: { label: resolved.tokenLabel },
      timeoutMs: resolved.fetchTimeoutMs,
    })
    if (created.status === 201 && created.json !== null && typeof created.json === 'object' && typeof (created.json as { secret?: unknown }).secret === 'string') {
      return (created.json as { secret: string }).secret
    }
  }
  const fallback = tokens.find((row) => row.label === 'default') ?? tokens[0]
  if (fallback !== undefined) {
    const secret = await fetchSecret(resolved, fallback.id)
    if (secret !== undefined) return secret
  }
  throw new Error('the gateway has no tokens to authenticate with; set gateway.token or create one in the panel')
}

/**
 * Read one token's secret.
 * @param resolved - resolved gateway config.
 * @param id - token id.
 * @returns the secret, or undefined on failure.
 */
async function fetchSecret(resolved: { url: string; fetchTimeoutMs: number }, id: string): Promise<string | undefined> {
  try {
    const { status, json } = await gatewayFetch(resolved.url + '/api/tokens/' + encodeURIComponent(id) + '/secret', { timeoutMs: resolved.fetchTimeoutMs })
    if (status === 200 && json !== null && typeof json === 'object' && typeof (json as { secret?: unknown }).secret === 'string') return (json as { secret: string }).secret
  } catch {
    // Fall through to the next resolution path.
  }
  return undefined
}

/**
 * Discover the gateway's MCP list and map it onto mcp-client configs.
 * Rows are filtered by 'include' / 'exclude' (names) and 'groups'; a row
 * whose name does not fit the mcp__<serverName>__<tool> budget (32 chars)
 * is skipped with a reason instead of breaking the whole layer.
 * @param resolved - resolved gateway config.
 * @param bearer - Authorization header value (already 'Bearer ...').
 * @returns the plan.
 * @throws when /api/mcps cannot be read.
 */
export async function fetchGatewayServers(resolved: DiscoveryConfig, bearer: string): Promise<GatewayPlan> {
  const { status, json } = await gatewayFetch(resolved.url + '/api/mcps', { timeoutMs: resolved.fetchTimeoutMs })
  if (status !== 200 || json === null || typeof json !== 'object' || !Array.isArray((json as { mcps?: unknown }).mcps)) {
    throw new Error('gateway /api/mcps answered ' + String(status))
  }
  const include = new Set(resolved.include)
  const exclude = new Set(resolved.exclude)
  const groups = new Set(resolved.groups)
  const configs: DiscoveredServer[] = []
  const skipped: string[] = []
  for (const row of (json as { mcps: Array<Record<string, unknown>> }).mcps) {
    if (row === null || typeof row !== 'object' || typeof row.name !== 'string') continue
    if (include.size > 0 && !include.has(row.name)) continue
    if (exclude.has(row.name)) {
      skipped.push(row.name + ' (excluded)')
      continue
    }
    if (groups.size > 0 && (typeof row.group !== 'string' || !groups.has(row.group))) continue
    if (!SERVER_NAME_PATTERN.test(row.name)) {
      skipped.push(row.name + ' (name longer than 32 chars or invalid for mcp__<name>__<tool>)')
      continue
    }
    configs.push({
      serverName: row.name,
      transport: 'streamable-http',
      url: resolved.url + '/' + encodeURIComponent(row.name),
      headers: { Authorization: bearer },
    })
  }
  return { configs, skipped }
}

/**
 * Run the whole discovery: health (with autostart), token, MCP list.
 * @param resolved - resolved gateway config.
 * @param log - info sink.
 * @returns null when the gateway is unreachable.
 * @throws only when 'required' is set and the gateway could not be used.
 */
export async function discoverGateway(resolved: GatewayConfig, log: (line: string) => void): Promise<GatewayPlan | null> {
  const running = await ensureGatewayRunning(resolved, log)
  if (!running) {
    const line = 'mcp-json-adapter: gateway not reachable at ' + resolved.url + '; gateway layer skipped'
    if (resolved.required) throw new Error(line)
    log(line)
    return null
  }
  const bearer = 'Bearer ' + await resolveBearerToken(resolved)
  const plan = await fetchGatewayServers(resolved, bearer)
  if (plan.skipped.length > 0) log('mcp-json-adapter: gateway skipped: ' + plan.skipped.join(', '))
  return plan
}
