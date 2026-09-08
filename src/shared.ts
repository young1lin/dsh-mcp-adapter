/**
 * Constants and helpers shared across adapter modules.
 *
 * @module dsh-mcp-adapter/shared
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** 'serverName' budget imposed by mcp-client's 'mcp__<serverName>__<tool>' names. */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** 'type' spellings accepted on url servers; all map to Streamable HTTP. */
export const HTTP_TYPES = new Set(['http', 'sse', 'streamable-http'])

/**
 * Expand supported tilde prefixes against the operating-system home.
 * @param path - configured path that may begin with '~'.
 * @returns the expanded path, or the original value.
 */
export function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}
