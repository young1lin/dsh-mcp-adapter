/**
 * '.mcp.json' file reading and mount planning: parse every layer file,
 * merge by name (later layer wins), validate each entry, and map entries
 * onto mcp-client plugin configs.
 *
 * @module dsh-mcp-adapter/plan
 */

import { readFile } from 'node:fs/promises'
import { SERVER_NAME_PATTERN, HTTP_TYPES } from './shared.js'

/** VAR references ('dollar-brace NAME brace') expanded from the process environment in 'env' values. */
const ENV_REF_SOURCE = '\\$\\{([A-Za-z_][A-Za-z0-9_]*)\\}'
const ENV_REF_PATTERN = new RegExp(ENV_REF_SOURCE, 'g')

/** Adapter-level options one planned server config inherits. */
export interface PlanServerOptions {
  projectRoot: string
  failOnStartupError: boolean
  toolCallTimeoutMs?: number
}

/** Everything planServers needs beyond the per-server options. */
export interface PlanOptions extends PlanServerOptions {
  disable: Set<string>
}

/** The full mount plan built from every layer file. */
export interface ServerPlan {
  configs: Record<string, unknown>[]
  skipped: string[]
  overridden: string[]
  loaded: string[]
}

/**
 * Read one .mcp.json file and return its 'mcpServers' mapping.
 * @param path - absolute file path.
 * @returns the mapping, or undefined when the file does not exist (a normal
 *   state for any layer).
 * @throws when the file is unreadable, not valid JSON, or has no
 *   'mcpServers' object.
 */
export async function readServerFile(path: string): Promise<Record<string, unknown> | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error('mcp-json-adapter: cannot read ' + path + ': ' + String(error))
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error('mcp-json-adapter: ' + path + ' is not valid JSON: ' + String(error))
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('mcp-json-adapter: ' + path + ' must contain a JSON object')
  }
  const servers = (parsed as Record<string, unknown>).mcpServers
  if (servers === undefined) {
    throw new Error('mcp-json-adapter: ' + path + ' has no "mcpServers" object')
  }
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) {
    throw new Error('mcp-json-adapter: "mcpServers" in ' + path + ' must be an object')
  }
  return servers as Record<string, unknown>
}

/**
 * Expand VAR references from the process environment in one env value.
 * Unset variables are kept literal (visible in the spawned environment, so
 * the failure stays diagnosable from the server side) and reported as a warning.
 * @param value - the raw env value from the file.
 * @param warnings - collector for unset-variable warnings.
 * @returns the expanded value.
 */
export function expandEnvValue(value: string, warnings: string[]): string {
  return value.replace(ENV_REF_PATTERN, (whole, varName: string) => {
    const fromEnv = process.env[varName]
    if (fromEnv === undefined) {
      warnings.push('environment variable ' + varName + ' is unset; kept the reference literal')
      return whole
    }
    return fromEnv
  })
}

/**
 * Map one .mcp.json server entry onto an mcp-client plugin config.
 * @param name - server name from the file; becomes 'serverName'.
 * @param spec - the entry's value.
 * @param source - file path the entry came from, for diagnostics.
 * @param adapter - adapter-level forwarding options.
 * @param warnings - collector for unset-variable warnings.
 * @returns one stdio or streamable-http mcp-client config.
 * @throws when the entry does not match the format.
 */
export function toServerConfig(name: string, spec: unknown, source: string, adapter: PlanServerOptions, warnings: string[]): Record<string, unknown> {
  const at = 'servers["' + name + '"] in ' + source
  if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
    throw new Error('mcp-json-adapter: ' + at + ' must be an object')
  }
  if (!SERVER_NAME_PATTERN.test(name)) {
    throw new Error(
      'mcp-json-adapter: server name "' + name + '" (' + source + ') must match /^[A-Za-z0-9_-]{1,32}$/ '
      + '(it becomes the mcp__<serverName>__<tool> namespace); rename it in the file',
    )
  }
  const entry = spec as Record<string, unknown>
  const type = entry.type
  if (type !== undefined && typeof type !== 'string') {
    throw new Error('mcp-json-adapter: ' + at + ': "type" must be a string')
  }
  const url = entry.url
  const command = entry.command
  if (url !== undefined && command !== undefined) {
    throw new Error('mcp-json-adapter: ' + at + ' has both "url" and "command"; provide exactly one')
  }
  const shared = { serverName: name, failOnStartupError: adapter.failOnStartupError }
  if (adapter.toolCallTimeoutMs !== undefined) (shared as Record<string, unknown>).toolCallTimeoutMs = adapter.toolCallTimeoutMs

  if (url !== undefined) {
    if (typeof url !== 'string') throw new Error('mcp-json-adapter: ' + at + ': "url" must be a string')
    try {
      new URL(url)
    } catch {
      throw new Error('mcp-json-adapter: ' + at + ': "url" is not a valid URL: ' + url)
    }
    if (type !== undefined && !HTTP_TYPES.has(type as string)) {
      throw new Error('mcp-json-adapter: ' + at + ': "type" "' + type + '" with a "url" must be "http", "sse", or "streamable-http"')
    }
    const headers = entry.headers === undefined ? {} : entry.headers
    if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) {
      throw new Error('mcp-json-adapter: ' + at + ': "headers" must be an object')
    }
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
      if (typeof value !== 'string') {
        throw new Error('mcp-json-adapter: ' + at + ': header "' + key + '" must be a string')
      }
    }
    return { transport: 'streamable-http', url, headers, ...shared }
  }

  if (command !== undefined) {
    if (typeof command !== 'string') throw new Error('mcp-json-adapter: ' + at + ': "command" must be a string')
    if (type !== undefined && type !== 'stdio') {
      throw new Error('mcp-json-adapter: ' + at + ': "type" "' + type + '" with a "command" must be "stdio"')
    }
    const args = entry.args === undefined ? [] : entry.args
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
      throw new Error('mcp-json-adapter: ' + at + ': "args" must be an array of strings')
    }
    const env = entry.env === undefined ? {} : entry.env
    if (typeof env !== 'object' || env === null || Array.isArray(env)) {
      throw new Error('mcp-json-adapter: ' + at + ': "env" must be an object')
    }
    const expandedEnv: Record<string, string> = {}
    for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
      if (typeof value !== 'string') {
        throw new Error('mcp-json-adapter: ' + at + ': env "' + key + '" must be a string')
      }
      expandedEnv[key] = expandEnvValue(value, warnings)
    }
    return { transport: 'stdio', command, args, env: expandedEnv, cwd: adapter.projectRoot, ...shared }
  }

  throw new Error('mcp-json-adapter: ' + at + ' needs either "command" (stdio server) or "url" (HTTP server)')
}

/**
 * Read every layer file and build the full mount plan.
 * @param resolved - the resolved adapter config.
 * @param files - layer file paths in precedence order (later wins).
 * @param warn - sink for non-fatal warnings.
 * @returns the plan.
 * @throws when any existing file is malformed or any entry is invalid;
 *   nothing is mounted or unmounted in that case.
 */
export async function planServers(resolved: PlanOptions, files: string[], warn: (line: string) => void): Promise<ServerPlan> {
  const merged = new Map<string, { spec: unknown; source: string }>()
  const overridden: string[] = []
  const loaded: string[] = []
  for (const path of files) {
    const servers = await readServerFile(path)
    if (servers === undefined) continue
    loaded.push(path)
    for (const [name, spec] of Object.entries(servers)) {
      if (merged.has(name)) overridden.push(name)
      merged.set(name, { spec, source: path })
    }
  }
  const warnings: string[] = []
  const errors: string[] = []
  const configs: Record<string, unknown>[] = []
  const skipped: string[] = []
  for (const [name, entry] of merged) {
    const spec = entry.spec
    if (spec !== null && typeof spec === 'object' && !Array.isArray(spec) && (spec as Record<string, unknown>).disabled === true) {
      skipped.push(name)
      continue
    }
    if (resolved.disable.has(name)) {
      skipped.push(name)
      continue
    }
    try {
      configs.push(toServerConfig(name, spec, entry.source, resolved, warnings))
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  if (errors.length > 0) {
    throw new Error(['mcp-json-adapter: refusing to mount MCP servers:'].concat(errors.map((line) => '- ' + line)).join('\n'))
  }
  for (const warning of new Set(warnings)) warn('mcp-json-adapter: ' + warning)
  return { configs, skipped, overridden, loaded }
}
