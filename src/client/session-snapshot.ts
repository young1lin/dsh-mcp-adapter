import type { SessionSnapshot } from './api.js'
import type { SessionServerView } from '../shared/session-view.js'

/** No config preview argument: it is NEVER a fallback for actual registration. */
export function registeredServers(snapshot?: SessionSnapshot): SessionServerView[] {
  if (snapshot === undefined || snapshot.restorable === false) return []
  if (snapshot.servers !== undefined) return snapshot.servers
  // An older host may expose v2 as flat names. Group namespace metadata only;
  // never guess its frozen transport/config from today's preview.
  const groups = new Map<string, SessionServerView>()
  for (const publicName of snapshot.tools) {
    const prefix = publicName.startsWith('mcp__') ? publicName.indexOf('__', 5) : -1
    const name = prefix >= 0 ? publicName.slice(5, prefix) : 'MCP'
    const toolName = prefix >= 0 ? publicName.slice(prefix + 2) : publicName
    const group = groups.get(name) ?? { name, transport: 'other', tools: [] }
    group.tools.push({ name: toolName, publicName })
    groups.set(name, group)
  }
  return [...groups.values()]
}
