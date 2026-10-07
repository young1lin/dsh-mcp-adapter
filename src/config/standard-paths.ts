/** Host-controlled standard layers, ordered lowest precedence first. */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { expandHome } from '../shared.js'

export interface StandardLayerPath {
  layerId: string
  path: string
}

/** Existing .agents/root definitions keep priority over newly discovered Claude files. */
export function projectStandardLayers(root: string): StandardLayerPath[] {
  return [
    { layerId: 'project:claude', path: join(root, '.claude', '.mcp.json') },
    { layerId: 'project:root', path: join(root, '.mcp.json') },
    { layerId: 'project:agents', path: join(root, '.agents', '.mcp.json') },
  ]
}

/** An explicit non-default globalFile still pins ONE file, as before. */
export function globalStandardLayers(globalFile?: string, homeDir = homedir()): StandardLayerPath[] {
  const agents = resolve(join(homeDir, '.agents', '.mcp.json'))
  const selected = globalFile === undefined ? agents : resolve(expandHome(globalFile))
  const canonical = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path
  if (canonical(selected) !== canonical(agents)) return [{ layerId: 'global:standard', path: selected }]
  return [
    { layerId: 'global:claude', path: resolve(join(homeDir, '.claude', '.mcp.json')) },
    { layerId: 'global:standard', path: selected },
  ]
}
