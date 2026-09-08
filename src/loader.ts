/**
 * Host-aware module loading. The adapter lives outside the harness install,
 * so bare specifiers ('@deepseek-ai/dsh-mcp-client', the MCP SDK,
 * schemastery) cannot resolve from its own location; the harness-internal
 * module loader resolves them against the host composition's base URL(s)
 * instead — the same mechanism agent-presets uses for preset rows. Every
 * host attempt falls back to a plain ambient import, which works when the
 * adapter sits inside a workspace that can see the harness packages.
 *
 * This module is the single home of that bases-then-ambient loop; the three
 * former copies (mcp-client, SDK, schemastery) collapsed into it.
 *
 * @module dsh-mcp-adapter/loader
 */

import type { Context, HostLoader } from './cordis.js'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

/** SDK modules for session mode, resolved through the harness install. */
export interface McpSdk {
  Client: typeof Client
  StdioClientTransport: typeof StdioClientTransport
  StreamableHTTPClientTransport: typeof StreamableHTTPClientTransport
}

/**
 * Composition base URLs host imports resolve against: the plugin context's
 * own base first, then the root composition's. Duplicates dropped.
 * @param ctx - plugin context.
 * @returns base URLs in preference order (possibly empty).
 */
function hostBases(ctx: Context): string[] {
  const bases: string[] = []
  const rootBase = ctx.root !== undefined ? ctx.root.baseUrl : undefined
  for (const candidate of [ctx.baseUrl, rootBase]) {
    if (typeof candidate === 'string' && candidate.length > 0 && !bases.includes(candidate)) bases.push(candidate)
  }
  return bases
}

/**
 * The harness-internal importer bound to its owner, when a loader is present.
 * @param ctx - plugin context.
 */
function hostImporter(ctx: Context): ((specifier: string, base: string, options: object) => Promise<unknown>) | undefined {
  if (typeof ctx.get !== 'function') return undefined
  const loader = ctx.get('loader') as HostLoader | undefined
  const internal = loader !== undefined ? loader.internal : undefined
  return internal !== undefined && typeof internal.import === 'function'
    ? internal.import.bind(internal)
    : undefined
}

/**
 * Import one specifier through every host base, then ambient. An optional
 * 'unwrap' validates/extracts the plugin object and runs INSIDE each attempt,
 * so an unwrappable module from one base falls through to the next chance.
 * @param ctx - plugin context.
 * @param specifier - package specifier to import.
 * @param unwrap - optional projection applied to every successful import.
 * @throws when no base or the ambient import resolves the specifier (or the
 *   unwrap rejects every resolved module).
 */
export async function importViaHost(ctx: Context, specifier: string, unwrap?: (mod: unknown) => unknown): Promise<unknown> {
  const importInternal = hostImporter(ctx)
  if (importInternal !== undefined) {
    for (const base of hostBases(ctx)) {
      try {
        const mod = await importInternal(specifier, base, {})
        return unwrap !== undefined ? unwrap(mod) : mod
      } catch {
        // This base did not resolve the package; the next base or the ambient
        // import below is the remaining chance.
      }
    }
  }
  const mod = await import(specifier)
  return unwrap !== undefined ? unwrap(mod) : mod
}

/**
 * Best-effort variant used per-specifier by the SDK import: every host base,
 * then ambient, resolving to undefined when nothing resolves.
 * @param ctx - plugin context.
 * @param specifier - package specifier to import.
 */
async function tryImport(ctx: Context, specifier: string): Promise<unknown> {
  const importInternal = hostImporter(ctx)
  if (importInternal !== undefined) {
    for (const base of hostBases(ctx)) {
      try {
        return await importInternal(specifier, base, {})
      } catch {
        // Next base, then the ambient import below.
      }
    }
  }
  try {
    return await import(specifier)
  } catch {
    return undefined
  }
}

/**
 * Pick the plugin object out of an imported module namespace, mirroring the
 * loader's 'unwrapExports': prefer a default export that carries 'apply',
 * else the namespace itself.
 * @param mod - imported module namespace or default.
 * @returns the Cordis plugin object.
 * @throws when neither form exports an 'apply' function.
 */
export function unwrapModule(mod: unknown): Record<string, unknown> {
  const candidate = mod !== null && typeof mod === 'object' && (mod as { default?: unknown }).default !== undefined
    ? (mod as { default: unknown }).default
    : mod
  if (candidate !== null && typeof candidate === 'object' && typeof (candidate as Record<string, unknown>).apply === 'function') {
    return candidate as Record<string, unknown>
  }
  throw new Error('mcp-json-adapter: @deepseek-ai/dsh-mcp-client did not export a Cordis plugin (no apply)')
}

/**
 * Import the mcp-client plugin through the host loader.
 * @param ctx - plugin context.
 * @returns the mcp-client plugin object.
 */
export async function importMcpClient(ctx: Context): Promise<Record<string, unknown>> {
  return (await importViaHost(ctx, '@deepseek-ai/dsh-mcp-client', unwrapModule)) as Record<string, unknown>
}

/**
 * Import schemastery through the host loader.
 * @param ctx - plugin context.
 * @returns the schemastery module namespace.
 */
export async function importSchemastery(ctx: Context): Promise<unknown> {
  return await importViaHost(ctx, '@deepseek-ai/schemastery')
}

/** SDK constructor specifiers, each resolved independently. */
const SDK_SPECS: Array<[keyof McpSdk, string]> = [
  ['Client', '@modelcontextprotocol/sdk/client/index.js'],
  ['StdioClientTransport', '@modelcontextprotocol/sdk/client/stdio.js'],
  ['StreamableHTTPClientTransport', '@modelcontextprotocol/sdk/client/streamableHttp.js'],
]

/**
 * Resolve the MCP SDK client and transports from the harness install. Each
 * constructor is resolved independently (one base answering Client but not a
 * transport is fine — the next base fills the gap); a constructor that
 * resolves to a non-function counts as unresolved.
 * @param ctx - plugin context.
 * @returns the SDK constructors.
 * @throws when no harness base can resolve the SDK package.
 */
export async function importMcpSdk(ctx: Context): Promise<McpSdk> {
  const sdk: Partial<Record<keyof McpSdk, unknown>> = {}
  for (const [key, specifier] of SDK_SPECS) {
    const mod = await tryImport(ctx, specifier)
    if (mod === undefined) continue
    const value = mod !== null && typeof mod === 'object' && (mod as { default?: unknown }).default !== undefined
      ? (mod as { default: unknown }).default
      : mod
    const ctor = value !== null && typeof value === 'object'
      ? ((value as Record<string, unknown>)[key] ?? value)
      : value
    if (typeof ctor === 'function') sdk[key] = ctor
  }
  for (const [key] of SDK_SPECS) {
    if (sdk[key] === undefined) throw new Error('mcp-json-adapter: could not resolve @modelcontextprotocol/sdk from the harness install')
  }
  return sdk as unknown as McpSdk
}
