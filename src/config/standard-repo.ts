/**
 * Standard .mcp.json file repository: the ONE reader/writer for plaintext
 * MCP definition files (TASK P2.1/P2.2). A file's parsed document is the
 * edit unit — unknown top-level fields and unedited entries survive every
 * write verbatim; only the named entry is touched. Writes are serialized
 * per target (one queue per path), validated before anything is staged, and
 * land by atomic temp+rename so a torn file can never exist.
 *
 * Concurrency contract (TASK 3.4): every read returns a content-hash
 * revision; a write must carry the revision its author read. A mismatch —
 * the file changed underneath (an editor, another dsh window) — is refused
 * with CONFLICT, never overwritten. An uncooperative external editor cannot
 * participate in the transaction; that boundary is documented, not papered
 * over: last-writer-wins is exactly what expectedRevision exists to prevent.
 *
 * @module dsh-mcp-adapter/config/standard-repo
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { McpDefinition, StandardDoc, StandardFileProblem } from './types.js'

/** Server-name budget shared with the mcp-client namespace (verified in plan.ts upstream). */
const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/

/** Per-path write queues: every write to one file is serialized. */
const queues = new Map<string, Promise<unknown>>()

function enqueue<T>(path: string, job: () => Promise<T>): Promise<T> {
  const tail = queues.get(path) ?? Promise.resolve()
  const run = tail.then(job, job)
  queues.set(path, run.then(() => undefined, () => undefined))
  return run
}

/** Revision of a file's text: first 16 hex of sha256. Empty text = missing file. */
export function revisionOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
}

/** The empty document state for a missing file (a normal layer state). */
export function emptyDoc(path: string): StandardDoc {
  return { path, exists: false, revision: '', doc: {}, servers: {} }
}

/**
 * Read and parse one standard file. NEVER throws for ordinary states
 * (missing/unparsable): the problem rides the returned doc so a preview can
 * show it; only I/O errors other than ENOENT reject.
 * @param path - absolute file path (host-resolved).
 */
export async function readStandardFile(path: string): Promise<StandardDoc> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyDoc(path)
    const problem: StandardFileProblem = {
      path, code: 'UNREADABLE',
      message: 'cannot read ' + path + ': ' + String((error as Error).message),
    }
    const doc = emptyDoc(path)
    return Object.assign(doc, { problem })
  }
  const revision = revisionOf(text)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    const doc = emptyDoc(path)
    doc.exists = true
    return Object.assign(doc, {
      revision,
      problem: { path, code: 'NOT_JSON', message: path + ' is not valid JSON: ' + String((error as Error).message) } satisfies StandardFileProblem,
    })
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const doc = emptyDoc(path)
    doc.exists = true
    return Object.assign(doc, {
      revision,
      problem: { path, code: 'NOT_OBJECT', message: path + ' must contain a JSON object' } satisfies StandardFileProblem,
    })
  }
  const docObject = parsed as Record<string, unknown>
  const serversRaw = docObject.mcpServers
  if (serversRaw !== undefined && (typeof serversRaw !== 'object' || serversRaw === null || Array.isArray(serversRaw))) {
    const doc = emptyDoc(path)
    doc.exists = true
    return Object.assign(doc, {
      revision,
      problem: { path, code: 'BAD_SERVERS', message: '"mcpServers" in ' + path + ' must be an object' } satisfies StandardFileProblem,
    })
  }
  const servers = (serversRaw ?? {}) as Record<string, McpDefinition>
  return { path, exists: true, revision, doc: docObject, servers }
}

/**
 * Validate one entry definition ahead of a write. Mirrors the lenient
 * loader contract: unknown fields are legal (files authored for other MCP
 * clients load as-is); structural lies are refused BEFORE the file is
 * touched so a bad edit can never destroy the previous content.
 * @param name - entry name.
 * @param def - the definition to check.
 */
export function validateEntry(name: string, def: unknown): string | undefined {
  if (!NAME_RE.test(name)) return 'server name "' + name + '" must match [A-Za-z0-9_-]{1,64}'
  if (def === null || typeof def !== 'object' || Array.isArray(def)) {
    return 'servers["' + name + '"] must be an object'
  }
  const entry = def as Record<string, unknown>
  if (entry.disabled !== undefined && typeof entry.disabled !== 'boolean') {
    return 'servers["' + name + '"].disabled must be a boolean'
  }
  if (entry.command !== undefined && typeof entry.command !== 'string') {
    return 'servers["' + name + '"].command must be a string'
  }
  if (entry.url !== undefined && typeof entry.url !== 'string') {
    return 'servers["' + name + '"].url must be a string'
  }
  if (entry.command !== undefined && entry.url !== undefined) {
    return 'servers["' + name + '"] has both "url" and "command"; provide exactly one'
  }
  if (entry.command === undefined && entry.url === undefined && entry.disabled !== true) {
    return 'servers["' + name + '"] needs either "command" (stdio) or "url" (http)'
  }
  if (entry.env !== undefined) {
    if (typeof entry.env !== 'object' || entry.env === null || Array.isArray(entry.env)) {
      return 'servers["' + name + '"].env must be an object'
    }
    for (const [key, value] of Object.entries(entry.env as Record<string, unknown>)) {
      if (typeof value !== 'string') return 'servers["' + name + '"].env["' + key + '"] must be a string'
    }
  }
  if (entry.headers !== undefined) {
    if (typeof entry.headers !== 'object' || entry.headers === null || Array.isArray(entry.headers)) {
      return 'servers["' + name + '"].headers must be an object'
    }
    for (const [key, value] of Object.entries(entry.headers as Record<string, unknown>)) {
      if (typeof value !== 'string') return 'servers["' + name + '"].headers["' + key + '"] must be a string'
    }
  }
  return undefined
}

/** Error modes writeStandardFile can reject with (stable codes for the UI). */
export type StandardWriteError =
  | { code: 'CONFLICT'; message: string; currentRevision: string }
  | { code: 'INVALID'; message: string }
  | { code: 'IO'; message: string }

/**
 * Write a full document to one standard file under the revision contract.
 * @param path - absolute target path.
 * @param doc - the complete top-level object to persist.
 * @param expectedRevision - revision the caller read ('' = file must not exist).
 */
export async function writeStandardFile(
  path: string,
  doc: Record<string, unknown>,
  expectedRevision: string,
): Promise<{ revision: string }> {
  return enqueue(path, async () => {
    const current = await readStandardFile(path)
    if (current.revision !== expectedRevision) {
      return Promise.reject({
        code: 'CONFLICT',
        message: path + ' changed since it was read (expected ' + (expectedRevision || 'missing') + ', now ' + (current.revision || 'missing') + '); re-read and merge',
        currentRevision: current.revision,
      } satisfies StandardWriteError)
    }
    // A file whose current text is unparsable must never be overwritten — the
    // operator's broken edit stays on disk for them to fix (TASK 3.4).
    if (current.problem !== undefined && current.problem.code !== 'UNREADABLE') {
      return Promise.reject({ code: 'INVALID', message: current.problem.message } satisfies StandardWriteError)
    }
    const text = JSON.stringify(doc, null, 2) + '\n'
    const staged = join(dirname(path), '.' + path.split(/[\\/]/).pop()! + '.tmp-' + process.pid + '-' + Date.now())
    try {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(staged, text, 'utf8')
      await rename(staged, path)
    } catch (error) {
      await rm(staged, { force: true }).catch(() => undefined)
      return Promise.reject({ code: 'IO', message: 'cannot write ' + path + ': ' + String((error as Error).message) } satisfies StandardWriteError)
    }
    return { revision: revisionOf(text) }
  })
}

/**
 * Point-edit one entry in a standard file: read-modify-write under the
 * revision contract, unknown fields and sibling entries preserved verbatim.
 * @param path - absolute target path.
 * @param name - entry name.
 * @param def - the new definition (null deletes the entry).
 * @param expectedRevision - revision the caller read.
 */
export async function upsertStandardEntry(
  path: string,
  name: string,
  def: McpDefinition | null,
  expectedRevision: string,
): Promise<{ revision: string }> {
  if (def !== null) {
    const invalid = validateEntry(name, def)
    if (invalid !== undefined) return Promise.reject({ code: 'INVALID', message: invalid } satisfies StandardWriteError)
  }
  return enqueue(path, async () => {
    const current = await readStandardFile(path)
    if (current.revision !== expectedRevision) {
      return Promise.reject({
        code: 'CONFLICT',
        message: path + ' changed since it was read; re-read and merge',
        currentRevision: current.revision,
      } satisfies StandardWriteError)
    }
    if (current.problem !== undefined && current.problem.code !== 'UNREADABLE') {
      return Promise.reject({ code: 'INVALID', message: current.problem.message } satisfies StandardWriteError)
    }
    const doc = current.doc
    const servers = { ...((doc.mcpServers as Record<string, unknown> | undefined) ?? {}) }
    if (def === null) delete servers[name]
    else servers[name] = def
    const next = { ...doc, mcpServers: servers }
    const text = JSON.stringify(next, null, 2) + '\n'
    const staged = join(dirname(path), '.' + path.split(/[\\/]/).pop()! + '.tmp-' + process.pid + '-' + Date.now())
    try {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(staged, text, 'utf8')
      await rename(staged, path)
    } catch (error) {
      await rm(staged, { force: true }).catch(() => undefined)
      return Promise.reject({ code: 'IO', message: 'cannot write ' + path + ': ' + String((error as Error).message) } satisfies StandardWriteError)
    }
    return { revision: revisionOf(text) }
  })
}
