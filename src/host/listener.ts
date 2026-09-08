/**
 * Where the MCP endpoint listens, and whether it is published at all.
 *
 * The engine always binds loopback so the host can reach it, but publishing
 * that endpoint is a decision with a blast radius: one HTTP port fronts every
 * configured MCP, and the server side decides which of them a caller gets. So
 * it is one explicit master switch and one port, not a side effect of anything
 * else.
 *
 * Two owners, in a fixed order:
 *  - the plugin config (`engine.publicMcp` / `engine.httpPort`) always wins. A
 *    value someone wrote into a config file must not be quietly overwritten by
 *    a switch in a panel; when it is set, the panel says so and stays read-only.
 *  - otherwise this file, written by the panel. It lives beside the engine's
 *    storage rather than in the engine's own data dir because the LISTENER is
 *    decided by the host before the engine exists — the supervisor needs the
 *    answer to spawn it.
 *
 * No relative runtime imports: the tests load this module as source.
 *
 * @module dsh-mcp-adapter/host/listener
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'

/** The port the endpoint uses when it is published and nobody named one. */
export const DEFAULT_MCP_PORT = 19999

/** What the panel stores. */
export interface ListenerSetting {
  enabled: boolean
  port: number
}

/** What the supervisor and the panel both read. */
export interface ListenerState extends ListenerSetting {
  /** The plugin config decides this; the panel must present it as read-only. */
  locked: boolean
}

/** The plugin-config half of the decision. */
export interface ListenerConfig {
  publicMcp?: boolean
  httpPort?: number
}

/** A usable listen port, or undefined. 0 is legal here and means "ephemeral". */
export function asPort(value: unknown): number | undefined {
  const n = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 65535) return undefined
  return n
}

/**
 * The effective listener: config first, then what the panel stored, then off.
 *
 * A published endpoint with no port named is DEFAULT_MCP_PORT — "on" has to
 * mean a port a client can be told about, and an ephemeral one changes on
 * every restart. Unpublished stays 0: the host reaches the engine over the
 * parent pipe, so the number is nobody's business.
 */
export function resolveListener(config: ListenerConfig | undefined, stored?: Partial<ListenerSetting>): ListenerState {
  const cfg = config ?? {}
  const locked = cfg.publicMcp !== undefined || cfg.httpPort !== undefined
  const enabled = cfg.publicMcp ?? (stored?.enabled === true)
  const named = cfg.httpPort ?? asPort(stored?.port)
  const port = named !== undefined && named > 0 ? named : (enabled ? DEFAULT_MCP_PORT : 0)
  return { enabled, port, locked }
}

/**
 * Can we actually bind this port? Asked by BINDING it, not by connecting to
 * it: a connect probe cannot tell "nothing is listening" from "something is
 * listening on a different interface", and the answer that matters is the one
 * the engine's own bind will get.
 *
 * 19999 is a popular answer to "pick a port" — it is what the standalone
 * gateway defaults to as well — so a clash is ordinary, not exotic.
 */
export async function portFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  if (port <= 0) return true // ephemeral: the OS picks a free one by definition
  return await new Promise<boolean>((resolve) => {
    const probe = createServer()
    const done = (free: boolean): void => { probe.removeAllListeners(); probe.close(() => resolve(free)) }
    probe.once('error', () => { done(false) })
    probe.once('listening', () => { done(true) })
    try {
      probe.listen(port, host)
    } catch {
      resolve(false)
    }
  })
}

/**
 * The listener as it will actually be, having asked the OS.
 *
 * A port someone else holds must NOT take the plugin down with it: failing to
 * start left the user with no panel, and so no way to reach the very switch
 * that would have fixed it. Unpublished-with-a-reason is the recoverable
 * failure; a dead plugin is not.
 */
export async function applyListener(state: ListenerState): Promise<ListenerState & { problem?: string }> {
  if (!state.enabled || state.port <= 0) return state
  if (await portFree(state.port)) return state
  return {
    enabled: false,
    port: 0,
    locked: state.locked,
    problem: 'port ' + String(state.port) + ' is already in use — the MCP endpoint was not published',
  }
}

function file(storageDir: string): string {
  return join(storageDir, 'listener.json')
}

/** What the panel last stored, or undefined when it never has (or the file is unusable). */
export function readListener(storageDir: string): ListenerSetting | undefined {
  let raw: string
  try {
    raw = readFileSync(file(storageDir), 'utf8')
  } catch {
    return undefined // never written: not a failure, just the default
  }
  try {
    const value: unknown = JSON.parse(raw)
    if (value === null || typeof value !== 'object') return undefined
    const v = value as { enabled?: unknown; port?: unknown }
    const port = asPort(v.port)
    return { enabled: v.enabled === true, port: port ?? 0 }
  } catch {
    // A corrupt file must not take the plugin down with it — the endpoint is
    // simply not published until someone sets it again.
    return undefined
  }
}

/** Persist the panel's choice. Throws on a port that is not one. */
export function writeListener(storageDir: string, value: { enabled: unknown; port: unknown }): ListenerSetting {
  const port = asPort(value.port)
  if (port === undefined) throw new Error('port must be an integer between 0 and 65535')
  const enabled = value.enabled === true
  const setting: ListenerSetting = { enabled, port: enabled && port === 0 ? DEFAULT_MCP_PORT : port }
  const target = file(storageDir)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, JSON.stringify(setting, null, 2) + '\n', 'utf8')
  return setting
}
