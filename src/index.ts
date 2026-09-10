/**
 * DeepSeek Harness plugin that mounts MCP servers declared in the widely
 * adopted '.mcp.json' format, hosting them in a plugin-owned engine child.
 *
 * This is the MCP-ONLY build of the plugin: apply() refuses to run without
 * the 'engine' block. The legacy global-mount chain (plan/gateway/embed/
 * session bridge, the SSH tunnels and DB browsers of the merged gateway) was
 * surgically removed on this branch — every server is hosted by the private
 * engine child and registered per session by the agent plane.
 *
 * Tools register at LOAD time only and never change afterwards: the global
 * layer settles once at host activation, the per-workspace layer once at
 * session creation. A live-mutating tool set would invalidate every prompt
 * cache prefix and desync a session's history from its capabilities, so
 * file edits apply to the NEXT load (host restart for the global layer, new
 * session for a workspace), never to a running one.
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
 * Each entry becomes one engine-hosted instance whose tools register per
 * session as 'mcp__<serverName>__<tool>'. Entries with "disabled": true are
 * tombstones that shadow the same name in lower layers.
 *
 * This module is the entry only: validation lives in './config.ts', the
 * unified host activation in './host/unified.ts', the agent plane in
 * './agent.ts', the session runtime in './runtime/session-runtime.ts', and
 * the engine child in './engine/ipc-main.ts'.
 *
 * @module dsh-mcp-adapter
 */

import { validateConfig } from './config.js'
import type { Context } from './cordis.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'mcp-json-adapter'

/**
 * No service injections. The loader (when present) is read opportunistically
 * via 'ctx.get' so the plugin also mounts inside loader-less compositions.
 */
export const inject: string[] = []

/**
 * Start the unified host: one engine child, one config service, the agent
 * plane mounting every session's tools into that session's own scope, and
 * the same-origin management bridge for the browser half.
 * @param ctx - plugin context.
 * @param config - adapter config from the loader entry.
 * @throws when a required key is missing or wrongly typed — notably when the
 *   'engine' block is absent, which this build cannot run without.
 */
export async function apply(ctx: Context, config: unknown): Promise<void> {
  const resolved = validateConfig(config)
  if (resolved.engine === null) {
    // The other machine's failure mode, made loud on purpose: a source
    // install of this branch without `engine: true` would otherwise mount
    // nothing and look broken in a way no log line explains.
    throw new Error(
      'mcp-json-adapter: this build is engine-only — add "engine: true" to the plugin config '
      + '(the legacy global-mount chain was removed on the mcp-only branch)',
    )
  }
  // Keys the legacy chain consumed; accepted so old patch entries keep
  // loading, but nothing on this branch reads them. Say so once instead of
  // letting them promise behavior that no longer exists.
  const inert = Object.keys((config ?? {}) as Record<string, unknown>)
    .filter((key) => key !== 'engine' && key !== 'globalFile' && key !== 'toolCallTimeoutMs')
  if (inert.length > 0) {
    ctx.logger.warn('mcp-json-adapter: config keys ignored by the mcp-only build: ' + inert.sort().join(', '))
  }
  const { startUnifiedHost } = await import('./host/unified.js')
  await startUnifiedHost(ctx, resolved)
}
