/**
 * Child side of the host<->engine IPC protocol: a method table over the
 * framed stdio channel (see ../shared/ipc-protocol.ts). The engine exposes
 * ONLY this surface to its parent — the loopback HTTP listener serves MCP
 * endpoints and health probes, never management for the dsh UI, which the
 * host proxies through here. One dispatch, one validation seam, one place
 * where secrets are kept out of logs.
 *
 * @module dsh-mcp-adapter/engine/ipc-service
 */

import type { Engine } from "./engine-main.js";
import { ADMIN_METHODS } from "./ipc-admin.js";
import { makeAdapter } from "./adapters/factory.js";
import { openSession } from "./introspect.js";
import { listPage, newPageCache, PAGE_SIZE } from "./paging.js";
import { withCallSource } from "./calls.js";
import { logicalKeyOf } from "../shared/instance-name.js";
import {
  IPC_PROTOCOL_VERSION,
  encodeFrame,
  ipcError,
  parseFrame,
  type IpcCancel,
  type IpcRequest,
} from "../shared/ipc-protocol.js";

/** Streams the service talks to (the child's stdio in production). */
export interface IpcIo {
  input: NodeJS.ReadableStream
  output: NodeJS.WritableStream
}

/** Log sink for protocol-level diagnostics (method + code only, never params). */
export type IpcLog = (line: string) => void

/** One dispatched method: validate params, run against the engine. */
export type IpcMethod = (engine: Engine, params: unknown, signal: AbortSignal) => Promise<unknown>

const runtimeDefinitions = new WeakMap<Engine, Map<string, string>>()
function stableDefinition(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableDefinition).join(',') + ']'
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + stableDefinition(v)).join(',') + '}'
  return JSON.stringify(value) ?? 'null'
}

/** The method table this engine build serves. */
const METHODS: Record<string, IpcMethod> = {
  ...ADMIN_METHODS,
  "ping": async () => ({ pong: true, pid: process.pid, uptimeMs: process.uptime() * 1000 }),
  "engine.status": async (engine) => ({
    port: engine.port,
    host: engine.host,
    mcps: engine.registry.status(),
    tokens: engine.tokens.list().length,
  }),
  /** The default bearer the private engine seeded; crosses only the parent pipe. */
  "engine.bearer": async (engine) => {
    const rec = engine.tokens.get("default") ?? engine.tokens.list()[0]
    if (rec === undefined) throw new Error("engine has no tokens")
    const full = engine.tokens.get(rec.id)
    return { id: rec.id, secret: full?.secret ?? "" }
  },
  "engine.shutdown": async (engine, _params, signal) => {
    // The reply is written by the dispatcher BEFORE dispose tears the process
    // down; see serveIpc's shutdown handling.
    void signal
    await engine.dispose()
    return { stopped: true }
  },

  // --- MCP domain (P3): the host's session/management plane ---------------------

  /** Immutable runtime registration: a name may never change its connection. */
  "mcp.ensure": async (engine, params) => {
    const p = params as { name?: unknown; def?: unknown; start?: unknown; resolved?: unknown }
    let name = String(p.name ?? "")
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test(name)) throw new Error("mcp.ensure: invalid name")
    if (p.def === null || typeof p.def !== "object" || Array.isArray(p.def)) throw new Error("mcp.ensure: def must be an object")
    const def = structuredClone(p.def) as Record<string, unknown>
    let fingerprints = runtimeDefinitions.get(engine)
    if (fingerprints === undefined) { fingerprints = new Map(); runtimeDefinitions.set(engine, fingerprints) }
    const fingerprint = stableDefinition(def)
    if (engine.registry.has(name)) {
      if (fingerprints.get(name) !== fingerprint) throw Object.assign(new Error("runtime name already belongs to a different definition"), { code: "E_ENGINE_STATE" })
    } else {
      /**
       * ONE instance per DEFINITION, whoever asks and by whatever name.
       *
       * The name a caller brings is only its own handle: a session mints
       * s<workspace>-<def>-<tail>, the settings panel asks for the catalog
       * name. Registering each of those separately built a second COPY of the
       * same server — and for a stdio child that is a whole second process
       * tree. Measured on one `npx -y @z_ai/mcp-server` entry: 265 MB per copy,
       * of which the server itself is 71 MB. Two projects with the same MCP
       * paid it twice; opening the panel on a server a session was already
       * running paid it again.
       *
       * So an identical definition is answered with the instance already
       * hosting it, and the caller is told which name that is (it addresses
       * the reply's `name`, never the one it sent). Definitions that differ in
       * any way — a per-project override, another API key — hash differently
       * and still get an instance of their own, which is the isolation that
       * mattered; the workspace was never what provided it.
       */
      const twin = [...fingerprints].find(([n, f]) => f === fingerprint && engine.registry.has(n))
      if (twin !== undefined) name = twin[0]
      else {
        const adapter = makeAdapter(def as never, name, p.resolved === true)
        // What the user turned off stays off across a restart. The caller's def is the
        // CONFIG's, which knows nothing of the panel's toggles, so they are applied here
        // from the store — under the entry's key, which every instance of it shares.
        const key = logicalKeyOf(name)
        const off = engine.store.disabledTools(key)
        if (off.length > 0 && adapter.toolToggle) adapter.toolToggle.disabled = new Set(off)
        const resourcesOn = engine.store.resourceEnabled(key)
        if (resourcesOn !== undefined && adapter.resourceToggle) adapter.resourceToggle.on = resourcesOn
        engine.registry.register(name, "managed", def as never, adapter)
        fingerprints.set(name, fingerprint)
      }
    }
    if (p.start !== false) await engine.registry.start(name).catch(() => undefined)
    const e = engine.registry.get(name)
    // `name` is the answer, not an echo: when it differs from what was asked for, this definition
    // was already hosted and the caller must address the instance named here from now on.
    return {
      name, lifecycle: e?.lifecycle, state: e ? (e.lifecycle === "started" ? e.status : e.lifecycle) : "unknown",
      ...(name !== String(p.name ?? "") ? { reused: true } : {}),
      ...(e?.error ? { reason: e.error } : {}),
    }
  },

  /** Idempotent release of a plugin-owned runtime instance, never legacy config. */
  "mcp.release": async (engine, params) => {
    const name = String((params as { name?: unknown })?.name ?? "")
    const owned = runtimeDefinitions.get(engine)
    if (owned?.has(name)) {
      if (engine.registry.has(name)) await engine.registry.delete(name)
      owned.delete(name)
    }
    return { released: name }
  },

  /** Remove one MCP (host-initiated; stops it first). */
  "mcp.remove": async (engine, params) => {
    const name = String((params as { name?: unknown })?.name ?? "")
    if (!engine.registry.has(name)) throw new Error("unknown MCP: " + name)
    await engine.registry.delete(name)
    engine.store.remove(name)
    return { removed: name }
  },

  /** Paged tools list for one MCP (engine-side cache, disabled names included). */
  "mcp.tools": async (engine, params, signal) => {
    const p = params as { name?: unknown; cursor?: unknown }
    const e = await requireStarted(engine, String(p.name ?? ""))
    e.toolPage ??= newPageCache()
    const server = e.adapter.makeServer ? e.adapter.makeServer() : e.server!
    const client = await openSession(server)
    try {
      const page = await listPage(client, "tools", e.toolPage, typeof p.cursor === "string" ? p.cursor : undefined)
      void signal
      return { tools: page.items, nextCursor: page.nextCursor, total: page.total, pageSize: PAGE_SIZE, disabledTools: engine.store.disabledTools(logicalKeyOf(e.name)) }
    } finally {
      await client.close().catch(() => undefined)
    }
  },

  /** Invoke one tool on behalf of a host session (source-attributed in the call log). */
  "mcp.call": async (engine, params, signal) => {
    const p = params as { name?: unknown; tool?: unknown; arguments?: unknown; timeoutMs?: unknown; source?: unknown }
    const e = await requireStarted(engine, String(p.name ?? ""))
    const tool = String(p.tool ?? "")
    if (tool.length === 0) throw new Error("mcp.call: tool is required")
    const args = p.arguments !== null && typeof p.arguments === "object" ? (p.arguments as Record<string, unknown>) : {}
    // Call-log attribution: model traffic rides as dsh-session; a manual Run
    // from the panel is its OWN source (P3.9), never disguised as the model's.
    const source = p.source === "panel" ? "panel" : "dsh-session"
    engine.registry.noteActivity(e.name)
    const server = e.adapter.makeServer ? e.adapter.makeServer() : e.server!
    const t0 = Date.now()
    return await withCallSource(source, async () => {
      const client = await openSession(server)
      // The v2 SDK callTool takes no request options here, so cancellation and
      // the deadline race the call and tear down the THROWAWAY session — the
      // shared child/server underneath keeps serving everyone else.
      const timeoutMs = typeof p.timeoutMs === "number" && p.timeoutMs > 0 ? p.timeoutMs : 180000
      if (signal.aborted) { await client.close(); throw Object.assign(new Error("call interrupted"), { code: "E_CANCELLED" }) }
      let interrupted: (() => void) | undefined
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined
      const aborted = new Promise<never>((_, reject) => {
        interrupted = () => reject(Object.assign(new Error("call interrupted"), { code: "E_CANCELLED" }))
        signal.addEventListener("abort", interrupted, { once: true })
      })
      const deadline = new Promise<never>((_, reject) => {
        const t = setTimeout(() => {
          reject(Object.assign(new Error("mcp.call timed out after " + String(timeoutMs) + "ms"), { code: "E_TIMEOUT" }))
        }, timeoutMs)
        deadlineTimer = t
        t.unref()
      })
      try {
        const out = (await Promise.race([
          client.callTool({ name: tool, arguments: args } as never),
          aborted,
          deadline,
        ])) as { content?: Array<{ type?: string; text?: string }>; isError?: boolean; structuredContent?: unknown }
        return {
          ok: out.isError !== true,
          isError: out.isError === true,
          ms: Date.now() - t0,
          content: out.content ?? [],
          ...(out.structuredContent !== undefined ? { structuredContent: out.structuredContent } : {}),
        }
      } catch (err) {
        void client.close().catch(() => undefined)
        throw err
      } finally {
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
        if (interrupted !== undefined) signal.removeEventListener("abort", interrupted)
        await client.close().catch(() => undefined)
      }
    })
  },

  /** Paged resources list for one MCP (adminapi parity, cache on the entry). */
  "mcp.resources": async (engine, params, signal) => {
    const p = params as { name?: unknown; cursor?: unknown }
    const e = await requireStarted(engine, String(p.name ?? ""))
    e.resPage ??= newPageCache()
    const server = e.adapter.makeServer ? e.adapter.makeServer() : e.server!
    const client = await openSession(server)
    try {
      const page = await listPage(client, "resources", e.resPage, typeof p.cursor === "string" ? p.cursor : undefined)
      void signal
      return {
        resources: page.items,
        nextCursor: page.nextCursor,
        total: page.total,
        resourceEnabled: e.adapter.resourceToggle ? e.adapter.resourceToggle.on : true,
      }
    } finally {
      await client.close().catch(() => undefined)
    }
  },

  /** Read one resource URI (source-attributed like a tool call). */
  "mcp.resourceRead": async (engine, params, signal) => {
    const p = params as { name?: unknown; uri?: unknown }
    const uri = String(p.uri ?? "")
    if (uri.length === 0) throw new Error("mcp.resourceRead: uri is required")
    const e = await requireStarted(engine, String(p.name ?? ""))
    engine.registry.noteActivity(e.name)
    const server = e.adapter.makeServer ? e.adapter.makeServer() : e.server!
    return await withCallSource("dsh-session", async () => {
      const client = await openSession(server)
      try {
        const out = (await client.readResource({ uri } as never)) as {
          contents?: Array<{ uri?: string; mimeType?: string; text?: string; blob?: string }>
        }
        void signal
        const text = (out.contents ?? []).map((c) => c.text ?? (c.blob ? "[binary " + String(Buffer.from(c.blob, "base64").length) + " bytes]" : "")).join("\n\n")
        return { ok: true, mimeType: out.contents?.[0]?.mimeType, text }
      } finally {
        await client.close().catch(() => undefined)
      }
    })
  },

  /** Paged prompts list for one MCP. */
  "mcp.prompts": async (engine, params, signal) => {
    const p = params as { name?: unknown; cursor?: unknown }
    const e = await requireStarted(engine, String(p.name ?? ""))
    e.promptPage ??= newPageCache()
    const server = e.adapter.makeServer ? e.adapter.makeServer() : e.server!
    const client = await openSession(server)
    try {
      const page = await listPage(client, "prompts", e.promptPage, typeof p.cursor === "string" ? p.cursor : undefined)
      void signal
      return { prompts: page.items, nextCursor: page.nextCursor, total: page.total }
    } finally {
      await client.close().catch(() => undefined)
    }
  },

  /** Toggle one tool on/off (live + persisted + list_changed notify; adminapi parity). */
  "mcp.setToolEnabled": async (engine, params) => {
    const p = params as { name?: unknown; tool?: unknown; enabled?: unknown }
    const name = String(p.name ?? "")
    const tool = String(p.tool ?? "")
    const e = engine.registry.get(name)
    if (e === undefined) throw new Error("unknown MCP: " + name)
    const set = e.adapter.toolToggle?.disabled
    if (set === undefined) throw new Error("tool toggles are not supported for MCP type '" + e.adapter.type + "'")
    const enabled = p.enabled !== false
    if (enabled) set.delete(tool)
    else set.add(tool)
    const disabled = [...set]
    // Filed under the ENTRY, not this instance: an instance name carries a hash of the
    // definition, so a toggle saved against one was forgotten by the next edit and was
    // invisible to every other instance of the same server.
    engine.store.setDisabledTools(logicalKeyOf(name), disabled)
    e.toolPage = undefined
    await engine.registry.notifyToolsChanged(name)
    return { tool, enabled, disabledTools: disabled }
  },

  /** Toggle an MCP's resources on/off (master switch). */
  "mcp.setResourcesEnabled": async (engine, params) => {
    const p = params as { name?: unknown; enabled?: unknown }
    const name = String(p.name ?? "")
    const e = engine.registry.get(name)
    if (e === undefined) throw new Error("unknown MCP: " + name)
    const toggle = e.adapter.resourceToggle
    if (toggle === undefined) throw new Error("resource toggle is not supported for MCP type '" + e.adapter.type + "'")
    toggle.on = p.enabled !== false
    engine.store.setResourceEnabled(logicalKeyOf(name), toggle.on)
    e.resPage = undefined
    await engine.registry.notifyResourcesChanged(name)
    return { enabled: toggle.on }
  },

  /** Lifecycle with store sync (adminapi parity, engine-plane). */
  "mcp.start": lifecycle("start"),
  "mcp.stop": lifecycle("stop"),
  "mcp.restart": lifecycle("restart"),

  /** Engine memory footprint (process tree optional). */
  "engine.memory": async (engine, params) => {
    const { getMemoryInfo } = await import("./mem.js")
    const p = (params ?? {}) as { tree?: unknown }
    const roots = engine.registry.childPids()
    return await getMemoryInfo(roots, p.tree === true)
  },

  /** One MCP's live details for the host UI. */
  "mcp.status": async (engine, params) => {
    const name = String((params as { name?: unknown })?.name ?? "")
    const e = engine.registry.get(name)
    if (e === undefined) throw new Error("unknown MCP: " + name)
    return {
      name,
      type: e.adapter.type,
      lifecycle: e.lifecycle,
      state: e.lifecycle === "started" ? e.status : e.lifecycle,
      reason: e.lifecycle === "error" ? e.error : e.lastError,
      logs: e.adapter.logs?.() ?? "",
      pids: e.adapter.pids?.() ?? [],
    }
  },

}
/** Build one lifecycle verb method against the registry + store. */
function lifecycle(verb: "start" | "stop" | "restart"): IpcMethod {
  return async (engine, params) => {
    const name = String((params as { name?: unknown })?.name ?? "")
    const e = engine.registry.get(name)
    if (e === undefined) throw new Error("unknown MCP: " + name)
    if (verb === "start") await engine.registry.start(name)
    else if (verb === "stop") await engine.registry.stop(name)
    else await engine.registry.restart(name)
    engine.store.setEnabled(name, verb !== "stop")
    return { name, lifecycle: engine.registry.get(name)?.lifecycle }
  }
}

async function requireStarted(engine: Engine, name: string) {
  const e = engine.registry.get(name)
  if (e === undefined) throw new Error("unknown MCP: " + name)
  if (e.lifecycle === "idle") {
    // Wake a lazy proc: the host's request is the wakeup (registry contract).
    const woke = await engine.registry.ensureStarted(name)
    if (woke.server === undefined) throw new Error("MCP '" + name + "' failed to start (state: " + woke.lifecycle + ")")
    return woke
  }
  if (e.server === undefined) throw new Error("MCP '" + name + "' is not started (state: " + e.lifecycle + ")")
  return e
}

/** Whether a method name exists in this build's table. */
export function hasIpcMethod(method: string): boolean {
  return Object.prototype.hasOwnProperty.call(METHODS, method)
}

/**
 * Serve the protocol on the given streams until the input ends.
 * @param engine - the running engine handle.
 * @param io - the stdio streams.
 * @param log - diagnostic sink.
 * @returns a promise settling when the input stream ends.
 */
export function serveIpc(engine: Engine, io: IpcIo, log: IpcLog = () => {}): Promise<void> {
  const inflight = new Map<number, AbortController>()
  let buffer = ""

  const write = (frame: Parameters<typeof encodeFrame>[0]): void => {
    io.output.write(encodeFrame(frame) + "\n")
  }

  return new Promise<void>((resolve) => {
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      for (const controller of inflight.values()) controller.abort()
      resolve()
    }

    io.input.on("data", (chunk: Buffer | string) => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8")
      let index: number
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        const frame = parseFrame(line)
        if (frame === undefined) {
          if (line.trim().length > 0) log("ipc: ignored a non-protocol line")
          continue
        }
        if (frame.t === "req") {
          void dispatchRequest(frame as IpcRequest)
        } else if (frame.t === "cancel") {
          const cancel = frame as IpcCancel
          inflight.get(cancel.id)?.abort()
        }
        // ready/ev/res from the host are not part of the child-side contract.
      }
    })
    io.input.on("end", finish)
    io.input.on("error", finish)

    async function dispatchRequest(req: IpcRequest): Promise<void> {
      const method = METHODS[req.method]
      if (method === undefined) {
        write({ t: "res", id: req.id, ok: false, error: ipcError("E_UNKNOWN_METHOD", "unknown method: " + req.method) })
        return
      }
      const controller = new AbortController()
      inflight.set(req.id, controller)
      try {
        const result = await method(engine, req.params, controller.signal)
        // engine.shutdown disposes the engine; the reply must still go out.
        write({ t: "res", id: req.id, ok: true, result })
        if (req.method === "engine.shutdown") {
          finish()
          setImmediate(() => process.exit(0))
        }
      } catch (err) {
        const code = controller.signal.aborted ? "E_CANCELLED" : "E_INTERNAL"
        const message = err instanceof Error ? err.message : String(err)
        log("ipc: " + req.method + " failed (" + code + ")")
        write({ t: "res", id: req.id, ok: false, error: ipcError(code, message) })
      } finally {
        inflight.delete(req.id)
      }
    }
  })
}

/** The handshake frame ipc-main emits once the engine is listening. */
export function readyFrame(version: string, pid: number, httpPort?: number) {
  return { t: "ready" as const, protocol: IPC_PROTOCOL_VERSION, version, pid, ...(httpPort === undefined ? {} : { httpPort }) }
}
