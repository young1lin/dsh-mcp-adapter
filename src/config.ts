/**
 * Adapter-own configuration: validation and defaults for the block the
 * loader entry passes to apply().
 *
 * @module dsh-mcp-adapter/config
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { expandHome } from './shared.js'
import { projectStandardLayers } from './config/standard-paths.js'

/** Adapter config keys; validated by hand in 'validateConfig'. */
const CONFIG_KEYS = new Set(['project', 'projectRoot', 'globalFile', 'projectFile', 'projectFiles', 'disable', 'failOnStartupError', 'toolCallTimeoutMs', 'watch', 'engine'])

/** The plugin-owned engine block: spawns dist/engine/ipc-main.js under this plugin. */
export interface EngineEmbedConfig {
  /** Deprecated, accepted for old configs but ignored: this plugin never opens an HTTP endpoint. */
  httpPort?: number
  /** Deprecated, accepted for old configs but ignored: the engine is IPC-only. */
  publicMcp?: boolean
  respawn: boolean
  storageDir?: string
  startupTimeoutMs?: number
  /**
   * Register each session's MCP tools from the HOST mount (default true).
   *
   * On, the host installs each session's tools without touching any preset.
   * Off, the host does not register session tools.
   */
  sessionTools: boolean
}

/** The fully validated adapter configuration. */
export interface ResolvedConfig {
  project: 'process' | 'session'
  projectRoot: string
  globalFile: string
  projectFiles: string[]
  disable: Set<string>
  failOnStartupError: boolean
  watch: boolean
  engine: EngineEmbedConfig | null
  toolCallTimeoutMs?: number
}

/**
 * Validate and default the adapter's own config.
 * @param raw - config from the loader entry (may be undefined).
 * @returns the resolved config.
 * @throws on unknown keys or wrongly typed values.
 */
export function validateConfig(raw: unknown): ResolvedConfig {
  const config = raw === undefined || raw === null ? {} : raw
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('mcp-json-adapter: config must be an object')
  }
  for (const key of Object.keys(config as Record<string, unknown>)) {
    // The mcp-only build dropped the discovery layer; say so instead of the
    // generic unknown-key message, because old patch entries still carry it.
    if (key === 'gateway') throw new Error('mcp-json-adapter: the "gateway" discovery block was removed in the mcp-only build — mount servers via .mcp.json layers or the panel instead')
    if (!CONFIG_KEYS.has(key)) throw new Error('mcp-json-adapter: unknown config key "' + key + '"')
  }
  const cfg = config as Record<string, unknown>
  const projectRoot = cfg.projectRoot === undefined ? process.cwd() : cfg.projectRoot
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw new Error('mcp-json-adapter: projectRoot must be a non-empty string')
  }
  const globalFile = cfg.globalFile === undefined ? join(homedir(), '.agents', '.mcp.json') : cfg.globalFile
  if (typeof globalFile !== 'string' || globalFile.length === 0) {
    throw new Error('mcp-json-adapter: globalFile must be a non-empty string')
  }
  const project = cfg.project === undefined ? 'process' : cfg.project
  if (project !== 'process' && project !== 'session') {
    throw new Error('mcp-json-adapter: project must be "process" or "session"')
  }
  const root = resolve(expandHome(projectRoot as string))
  let projectFiles: string[]
  if (cfg.projectFiles !== undefined) {
    if (!Array.isArray(cfg.projectFiles) || (cfg.projectFiles as unknown[]).some((entry) => typeof entry !== 'string' || (entry as string).length === 0)) {
      throw new Error('mcp-json-adapter: projectFiles must be an array of non-empty file paths')
    }
    if (project === 'session') {
      throw new Error('mcp-json-adapter: projectFiles applies to project: process only; session mode derives files from each session workspace')
    }
    projectFiles = (cfg.projectFiles as string[]).map((file) => resolve(expandHome(file)))
  } else if (cfg.projectFile !== undefined) {
    if (typeof cfg.projectFile !== 'string' || (cfg.projectFile as string).length === 0) {
      throw new Error('mcp-json-adapter: projectFile must be a non-empty string')
    }
    projectFiles = [resolve(expandHome(cfg.projectFile as string))]
  } else {
    projectFiles = projectStandardLayers(root).map((layer) => layer.path)
  }
  const disable = cfg.disable === undefined ? [] : cfg.disable
  if (!Array.isArray(disable) || (disable as unknown[]).some((entry) => typeof entry !== 'string')) {
    throw new Error('mcp-json-adapter: disable must be an array of server names')
  }
  const failOnStartupError = cfg.failOnStartupError === undefined ? false : cfg.failOnStartupError
  if (typeof failOnStartupError !== 'boolean') {
    throw new Error('mcp-json-adapter: failOnStartupError must be a boolean')
  }
  let toolCallTimeoutMs: number | undefined
  if (cfg.toolCallTimeoutMs !== undefined) {
    if (typeof cfg.toolCallTimeoutMs !== 'number' || !Number.isFinite(cfg.toolCallTimeoutMs) || (cfg.toolCallTimeoutMs as number) <= 0) {
      throw new Error('mcp-json-adapter: toolCallTimeoutMs must be a positive finite number')
    }
    toolCallTimeoutMs = cfg.toolCallTimeoutMs as number
  }
  const doWatch = cfg.watch === undefined ? false : cfg.watch
  if (typeof doWatch !== 'boolean') {
    throw new Error('mcp-json-adapter: watch must be a boolean')
  }
  // This build runs ONLY on the plugin-owned engine, so the engine is ON
  // unless explicitly refused. A bare entry (or `engine: true`) gets the
  // defaults; only `engine: false` is an error, because there is no other
  // mode to fall back to.
  let engine: EngineEmbedConfig | null = null
  if (cfg.engine === false) {
    throw new Error('mcp-json-adapter: this build runs only on the plugin-owned engine — remove "engine: false" (the engine is on unless you say otherwise)')
  }
  {
    const block = cfg.engine === undefined || cfg.engine === true ? {} : cfg.engine
    if (typeof block !== 'object' || Array.isArray(block)) {
      throw new Error('mcp-json-adapter: engine config must be an object (or true)')
    }
    for (const key of Object.keys(block as Record<string, unknown>)) {
      if (!['httpPort', 'publicMcp', 'respawn', 'storageDir', 'startupTimeoutMs', 'sessionTools'].includes(key)) {
        throw new Error('mcp-json-adapter: unknown engine config key "' + key + '"')
      }
    }
    const b = block as Record<string, unknown>
    if (b.httpPort !== undefined && (typeof b.httpPort !== 'number' || !Number.isInteger(b.httpPort) || (b.httpPort as number) < 0 || (b.httpPort as number) > 65535)) {
      throw new Error('mcp-json-adapter: engine.httpPort must be an integer between 0 and 65535 (0 = ephemeral)')
    }
    if (b.publicMcp !== undefined && typeof b.publicMcp !== 'boolean') {
      throw new Error('mcp-json-adapter: engine.publicMcp must be a boolean')
    }
    if (b.respawn !== undefined && typeof b.respawn !== 'boolean') {
      throw new Error('mcp-json-adapter: engine.respawn must be a boolean')
    }
    if (b.storageDir !== undefined && (typeof b.storageDir !== 'string' || (b.storageDir as string).length === 0)) {
      throw new Error('mcp-json-adapter: engine.storageDir must be a non-empty path')
    }
    if (b.startupTimeoutMs !== undefined && (typeof b.startupTimeoutMs !== 'number' || !Number.isFinite(b.startupTimeoutMs) || (b.startupTimeoutMs as number) <= 0)) {
      throw new Error('mcp-json-adapter: engine.startupTimeoutMs must be a positive finite number')
    }
    if (b.sessionTools !== undefined && typeof b.sessionTools !== 'boolean') {
      throw new Error('mcp-json-adapter: engine.sessionTools must be a boolean')
    }
    engine = {
      ...(b.httpPort !== undefined ? { httpPort: b.httpPort as number } : {}),
      ...(b.publicMcp !== undefined ? { publicMcp: b.publicMcp as boolean } : {}),
      respawn: b.respawn === undefined ? true : b.respawn as boolean,
      sessionTools: b.sessionTools === undefined ? true : b.sessionTools as boolean,
      ...(b.storageDir !== undefined ? { storageDir: b.storageDir as string } : {}),
      ...(b.startupTimeoutMs !== undefined ? { startupTimeoutMs: b.startupTimeoutMs as number } : {}),
    }
  }
  return {
    project: project as 'process' | 'session',
    projectRoot: root,
    globalFile: resolve(expandHome(globalFile as string)),
    projectFiles,
    disable: new Set(disable as string[]),
    failOnStartupError: failOnStartupError as boolean,
    watch: doWatch as boolean,
    engine,
    ...(toolCallTimeoutMs !== undefined ? { toolCallTimeoutMs } : {}),
  }
}
