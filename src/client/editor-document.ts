/** Accept a single definition or the first server in a client .mcp.json document. */
import { commandLine } from '../shared/command-line.js'

export interface EditorDocument {
  def?: Record<string, unknown>
  name?: string
  count?: number
  error?: 'editorJsonBadMap' | 'editorJsonEmptyMap' | 'editorJsonBadEntry'
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function readEditorDocument(text: string, native = false): EditorDocument | undefined {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return undefined }
  if (!record(raw)) return undefined
  let name: string | undefined, count: number | undefined
  let def = raw
  if (Object.hasOwn(raw, 'mcpServers')) {
    if (!record(raw.mcpServers)) return { error: 'editorJsonBadMap' }
    const entries = Object.entries(raw.mcpServers)
    if (entries.length === 0) return { error: 'editorJsonEmptyMap' }
    const first = entries[0]!
    if (!record(first[1])) return { error: 'editorJsonBadEntry' }
    name = first[0]; count = entries.length; def = first[1]
  }
  // HTTP and stdio client formats are portable into either target dialect.
  // Preserve unknown options and secrets; only translate the carrier fields.
  const type = typeof def.type === 'string' ? def.type : undefined
  if (native && typeof def.url === 'string' && (type === undefined || ['http', 'remote', 'sse', 'streamable-http'].includes(type))) {
    def = { ...def, type: 'http' }
  } else if (native && typeof def.command === 'string' && (type === undefined || type === 'stdio')) {
    const executable = Array.isArray(def.args) || type === 'stdio' || name !== undefined
    // A bare, untyped no-args command may be a legacy complete command line.
    // Wrapped mcpServers / explicit stdio use the client executable contract.
    def = { ...def, type: 'proc', command: commandLine(def.command, Array.isArray(def.args) ? def.args : [], executable) }
    delete def.args // native proc consumes a complete command line, not args
  }
  return { def, ...(name !== undefined ? { name, count } : {}) }
}
