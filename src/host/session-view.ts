import { isDeepStrictEqual } from 'node:util'
import type { SessionSnapshot } from '../config/session-store.js'
import type { ScopePreview } from '../config/types.js'
import { standardToNative } from '../config/transfer.js'
import { publicNameLite } from '../runtime/session-runtime.js'
import type { SessionSnapshotView, SessionConfigurationChanges } from '../shared/session-view.js'

/** Project ONLY display metadata from the sealed generation, never its config. */
export function snapshotView(snapshot: SessionSnapshot): SessionSnapshotView {
  const servers = snapshot.servers.map(server => ({
    name: server.logical,
    transport: server.def.type === 'http' ? 'http' as const : server.def.type === 'proc' ? 'stdio' as const : 'other' as const,
    tools: server.tools.map(tool => ({ name: tool.name, publicName: publicNameLite(server.logical, tool.name), ...(tool.description !== undefined ? { description: tool.description } : {}) })),
  }))
  return { revision: snapshot.configRevision, registeredAt: snapshot.registeredAt, restorable: true, servers, tools: servers.flatMap(server => server.tools.map(tool => tool.publicName)) }
}

/** Compare privately with real values; only counts cross the browser edge. */
export function configurationChanges(snapshot: SessionSnapshot, next: ScopePreview): SessionConfigurationChanges {
  const previous = new Map(snapshot.servers.map(server => [server.logical, server.def]))
  const current = new Map(next.entries.filter(entry => !entry.disabled).flatMap(entry => {
    const def = entry.source === 'standard' ? standardToNative(entry.def) : entry.def
    return def === undefined ? [] : [[entry.name, def] as const]
  }))
  return {
    added: [...current.keys()].filter(name => !previous.has(name)).length,
    removed: [...previous.keys()].filter(name => !current.has(name)).length,
    changed: [...current].filter(([name, def]) => previous.has(name) && !isDeepStrictEqual(previous.get(name), def)).length,
  }
}
