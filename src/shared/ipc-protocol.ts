/**
 * The versioned private IPC protocol between the dsh host plugin and the
 * embedded engine child process. Line-delimited JSON over the child's
 * stdin/stdout (stderr stays a log channel); the host NEVER exposes this
 * surface to the browser and the engine NEVER accepts it from anyone else —
 * a child process's stdio is a private pipe pair by construction.
 *
 * Message kinds:
 *   child -> host   {t:"ready", protocol, version, pid, httpPort?}     handshake
 *                   {t:"res", id, ok:true, result}                    reply
 *                   {t:"res", id, ok:false, error:{code,message}}     reply
 *                   {t:"ev", event, params}                           notification
 *   host  -> child  {t:"req", id, method, params}                     request
 *                   {t:"cancel", id}                                  cancellation
 *
 * Framing rules: one JSON object per \\n-terminated line, UTF-8, no embedded
 * newlines (JSON.stringify never emits raw newlines). Unknown message kinds
 * are ignored with a warning, never fatal — the two sides may come from
 * different plugin versions during an upgrade.
 *
 * Logging rule: protocol-level logs record method names, ids and error CODES
 * only. Params and results cross the pipe verbatim but never reach a log
 * line unredacted (the engine's mask layer owns domain-level redaction).
 *
 * @module dsh-mcp-adapter/shared/ipc-protocol
 */

/** Current protocol version; bump on breaking frame/method changes. */
export const IPC_PROTOCOL_VERSION = 1;

/** Stable machine-readable error codes crossing the boundary. */
export type IpcErrorCode =
  | "E_PROTOCOL"        // malformed frame / wrong version
  | "E_UNKNOWN_METHOD" // method not in this engine's table
  | "E_INVALID_PARAMS" // params failed the method's validation
  | "E_ENGINE_STATE"   // method invalid for the engine's current state
  | "E_ENGINE_BUSY"    // serialized op in flight
  | "E_INTERNAL"       // engine-side throw (message is safe to show)
  | "E_TIMEOUT"        // host-side request deadline expired
  | "E_DIED"           // engine process exited before answering
  | "E_CANCELLED";     // request cancelled by the host

/** The error shape on a failed reply. */
export interface IpcError {
  code: IpcErrorCode
  message: string
  data?: unknown
}

// --- frame types -------------------------------------------------------------------------------

/** Handshake the child emits once its engine is listening. */
export interface IpcReady {
  t: 'ready'
  protocol: number
  /** Engine package version (from package.json). */
  version: string
  /** Child PID, for the host's ownership ledger. */
  pid: number
  /** The engine HTTP listener port (loopback; ephemeral when configured with 0). */
  httpPort?: number
}

/** Host -> child request. */
export interface IpcRequest {
  t: 'req'
  id: number
  method: string
  params?: unknown
}

/** Host -> child cancellation. Idempotent; an answered id is ignored. */
export interface IpcCancel {
  t: 'cancel'
  id: number
}

/** Child -> host success reply. */
export interface IpcResult {
  t: 'res'
  id: number
  ok: true
  result: unknown
}

/** Child -> host failure reply. */
export interface IpcFailure {
  t: 'res'
  id: number
  ok: false
  error: IpcError
}

/** Child -> host notification (state changes, bounded log tail). */
export interface IpcEvent {
  t: 'ev'
  event: string
  params?: unknown
}

export type IpcFrameChildToHost = IpcReady | IpcResult | IpcFailure | IpcEvent
export type IpcFrameHostToChild = IpcRequest | IpcCancel
export type IpcFrame = IpcFrameChildToHost | IpcFrameHostToChild

// --- framing helpers ---------------------------------------------------------------------------

/**
 * Parse one line into a frame. Returns undefined for blank lines (tail
 * newlines are normal) and for values that are not protocol objects; the
 * caller logs and skips those rather than tearing the pipe down.
 * @param line - one \\n-stripped line from the stream.
 */
export function parseFrame(line: string): IpcFrame | undefined {
  const trimmed = line.trim()
  if (trimmed.length === 0) return undefined
  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const t = (value as Record<string, unknown>).t
  if (t !== 'ready' && t !== 'req' && t !== 'res' && t !== 'cancel' && t !== 'ev') return undefined
  return value as IpcFrame
}

/**
 * Serialize one frame to its wire line (no trailing newline).
 */
export function encodeFrame(frame: IpcFrame): string {
  return JSON.stringify(frame)
}

/** Build a protocol-level failure. */
export function ipcError(code: IpcErrorCode, message: string, data?: unknown): IpcError {
  return data === undefined ? { code, message } : { code, message, data }
}
