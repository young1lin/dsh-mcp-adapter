/**
 * Host-side supervisor for the plugin-owned engine child process.
 *
 * Ownership model (TASK P1.4): the child is spawned BY this process, over a
 * private stdio pipe, with DSH_MCP_OWNER naming this PID. A precise on-disk
 * ledger (one JSON file per live child, under <storage>/runtime/) records
 * pid/owner/entry; orphan recovery at the next boot kills ONLY a process
 * whose ledger entry exists, whose owner is dead, and whose command line
 * still names THIS package's ipc-main entry — never a machine-wide sweep by
 * command name, and never a pid the OS may have recycled without that triple
 * check.
 *
 * Lifecycle: bounded-backoff respawn on unexpected exit (stable after 60s
 * resets the counter); dispose() asks the engine to shut down over IPC,
 * waits, then tree-kills as the floor. A startup failure isolates: the
 * supervisor reports dead and does NOT respawn-loop a broken build.
 *
 * @module dsh-mcp-adapter/runtime/engine-supervisor
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseFrame, encodeFrame, type IpcEvent, type IpcFrame, type IpcReady, ipcError } from "../shared/ipc-protocol.js"
import { putSecret, openSecret } from "../sealed.js"

/** Backoff schedule for unexpected-exit respawns; exhausted = stay dead. */
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000]
/** Uptime after which the respawn counter resets. */
const STABLE_MS = 60000

/** Supervisor options. */
export interface SupervisorOptions {
  /** Plugin-private storage root (<dsh home>/mcp-manager). Created when missing. */
  storageDir: string
  /** Engine HTTP port; 0 (default) = ephemeral. */
  httpPort?: number
  publicMcp?: boolean
  publicNames?: string[]
  /** Explicit engine entry override; default resolves dist/engine/ipc-main.js next to this build. */
  entryPath?: string
  /** Node binary for the child (tests inject a fixed one). */
  nodeExecutable?: string
  /** Extra child env (merged over the scrubbed parent env). */
  env?: Record<string, string>
  /** Whether an unexpected exit respawns (default true). */
  respawn?: boolean
  /** How long to wait for the ready frame (default 20000ms). */
  startupTimeoutMs?: number
  /** Master key override (64 hex); default: sealed per-machine store slot. */
  masterKey?: string
}

/** Log sinks the supervisor narrates to. */
export interface SupervisorSinks {
  info(line: string): void
  warn(line: string): void
}

/** Public handle over one supervised engine. */
export interface EngineSupervisor {
  /** Spawn + handshake; resolves with the ready frame. Idempotent-ish: reuses a live child. */
  ensure(): Promise<IpcReady>
  /** One request over the private channel. */
  request(method: string, params?: unknown, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<unknown>
  /** Event subscription; returns the unsubscriber. */
  onEvent(handler: (event: IpcEvent) => void): () => void
  /** The engine HTTP origin (loopback), once ready. */
  httpOrigin(): string | undefined
  /** Whether the child is currently alive. */
  alive(): boolean
  /**
   * Identity of the CURRENT engine child (its pid; undefined while dead or
   * before the first ready frame). Changes across every respawn, so callers
   * can bind caches to a generation and drop them when the engine restarts.
   * Theoretically the OS can recycle a pid; the failure that leaves is one
   * stale cache window, no worse than the pre-epoch behavior.
   */
  epoch(): string | undefined
  /** Graceful stop; kills as the floor. Never throws. */
  dispose(): Promise<void>
  resume(): Promise<IpcReady>
}

/** Where the compiled engine entry lives relative to this module's build output. */
function defaultEntryPath(): string {
  // dist/runtime/engine-supervisor.js -> dist/engine/ipc-main.js
  return join(dirname(fileURLToPath(import.meta.url)), "..", "engine", "ipc-main.js")
}

/** The sealed-store slot holding the engine master key. */
const MASTER_KEY_SLOT = "engine-master-key"

/**
 * Resolve (or create+seal) the engine master key: 64 hex chars bound to this
 * machine via the plugin's sealed store, so engine state files are unreadable
 * anywhere else.
 */
export function engineMasterKey(storageDir: string, override?: string): string {
  if (override !== undefined && /^[0-9a-fA-F]{64}$/.test(override)) return override
  const existing = openSecret(MASTER_KEY_SLOT, join(storageDir, "sealed.json"))
  if (existing !== undefined && /^[0-9a-fA-F]{64}$/.test(existing)) return existing
  const fresh = randomBytes(32).toString("hex")
  putSecret(MASTER_KEY_SLOT, fresh, join(storageDir, "sealed.json"))
  return fresh
}

interface LedgerRecord {
  pid: number
  owner: number
  entry: string
  startedAt: string
}

function ledgerDir(storageDir: string): string {
  return join(storageDir, "runtime")
}

function writeLedger(storageDir: string, record: LedgerRecord): void {
  try {
    mkdirSync(ledgerDir(storageDir), { recursive: true })
    writeFileSync(join(ledgerDir(storageDir), `engine-${record.pid}.json`), JSON.stringify(record, null, 2))
  } catch { /* a missing ledger only costs orphan-sweep precision */ }
}

function dropLedger(storageDir: string, pid: number): void {
  try { rmSync(join(ledgerDir(storageDir), `engine-${pid}.json`), { force: true }) } catch { /* ignore */ }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

/**
 * Boot-time orphan recovery: kill ONLY children whose ledger entry exists,
 * whose recorded owner is dead, and whose live command line still names our
 * engine entry. Returns the pids handled. Never a name-based sweep.
 */
export function reapOrphanedEngines(storageDir: string, ownPid: number, warn: (line: string) => void): number[] {
  const dir = ledgerDir(storageDir)
  if (!existsSync(dir)) return []
  const handled: number[] = []
  for (const file of readdirSync(dir)) {
    if (!file.startsWith("engine-") || !file.endsWith(".json")) continue
    const path = join(dir, file)
    let record: LedgerRecord | undefined
    try {
      record = JSON.parse(readFileSync(path, "utf8")) as LedgerRecord
    } catch { rmSync(path, { force: true }); continue }
    if (record === undefined || typeof record.pid !== "number") { rmSync(path, { force: true }); continue }
    if (!pidAlive(record.pid)) { rmSync(path, { force: true }); continue }
    if (record.owner === ownPid || pidAlive(record.owner)) continue // owner still running: not an orphan
    // Owner dead + pid alive: verify the COMMAND LINE before killing — the pid
    // may have been recycled onto an unrelated process.
    if (!commandLineMatches(record.pid, record.entry)) {
      warn("engine-supervisor: pid " + record.pid + " no longer runs our entry; ledger dropped")
      rmSync(path, { force: true })
      continue
    }
    warn("engine-supervisor: reaping orphaned engine pid " + record.pid)
    void treeKill(record.pid)
    rmSync(path, { force: true })
    handled.push(record.pid)
  }
  return handled
}

function commandLineMatches(pid: number, entry: string): boolean {
  // Synchronous, best-effort. Windows: tasklist gives the image but not
  // args; wmic is gone on modern Windows, so the precise check uses
  // PowerShell's CIM. POSIX: /proc/<pid>/cmdline is the NUL-separated argv.
  // A failure reads as "not ours" — the safe direction (no kill).
  try {
    if (process.platform === "win32") {
      const out = execFileSync("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command",
        "(Get-CimInstance Win32_Process -Filter \"ProcessId=" + pid + '\").CommandLine',
      ], { encoding: "utf8", timeout: 10000, windowsHide: true })
      return out.includes(entry)
    }
    const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8")
    return argv.replace(/\0/g, " ").includes(entry)
  } catch {
    return false
  }
}

function treeKill(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
      killer.on("error", () => resolve())
      killer.on("exit", () => resolve())
    } else {
      try { process.kill(pid, "SIGKILL") } catch { /* already gone */ }
      resolve()
    }
  })
}

/** One pending request. */
interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/**
 * Build the supervisor. One instance owns at most one child at a time.
 * @param options - storage/port/env knobs.
 * @param sinks - host log sinks.
 */
export function createEngineSupervisor(options: SupervisorOptions, sinks: SupervisorSinks): EngineSupervisor {
  const entryPath = options.entryPath ?? defaultEntryPath()
  const httpPort = options.httpPort ?? 0
  const startupTimeoutMs = options.startupTimeoutMs ?? 20000
  const respawn = options.respawn !== false

  let child: ChildProcess | null = null
  let ready: IpcReady | undefined
  let stderrTail = ""
  let disposed = false
  let attempts = 0
  let respawnTimer: NodeJS.Timeout | undefined
  let nextId = 1
  let stdoutBuffer = ""
  const pending = new Map<number, Pending>()
  const eventHandlers = new Set<(event: IpcEvent) => void>()

  function childEnv(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue
      if (key.startsWith("DSH_") && key !== "DSH_HOME") continue
      if (/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/.test(key)) continue
      out[key] = value
    }
    delete out.MCP_GATEWAY_PORT
    out.DSH_MCP_PUBLIC = options.publicMcp === true ? "1" : "0"
    out.DSH_MCP_PUBLIC_NAMES = JSON.stringify(options.publicNames ?? [])
    out.MCP_GATEWAY_HOME = join(options.storageDir, "engine")
    // Port 0 (ephemeral) is the supervisor's DEFAULT but the engine's config
    // loader deliberately refuses it in MCP_GATEWAY_PORT (a stray empty value
    // must not silently bind somewhere random). Only a REAL port crosses the
    // env; ipc-main derives ephemeral from its own options instead.
    if (httpPort >= 1) out.MCP_GATEWAY_PORT = String(httpPort)
    out.MCP_GATEWAY_MASTER_KEY = engineMasterKey(options.storageDir, options.masterKey)
    out.DSH_MCP_OWNER = String(process.pid)
    for (const [key, value] of Object.entries(options.env ?? {})) out[key] = value
    return out
  }

  function failAllPending(code: "E_DIED" | "E_TIMEOUT" | "E_CANCELLED", message: string): void {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error(message + " (" + code + ")"))
    }
    pending.clear()
  }

  function handleFrame(frame: IpcFrame): void {
    if (frame.t === "ready") {
      ready = frame
      return
    }
    if (frame.t === "ev") {
      for (const handler of eventHandlers) {
        try { handler(frame) } catch { /* a subscriber bug must not kill the pipe */ }
      }
      return
    }
    if (frame.t === "res") {
      const entry = pending.get(frame.id)
      if (entry === undefined) return
      pending.delete(frame.id)
      clearTimeout(entry.timer)
      if (frame.ok) entry.resolve(frame.result)
      else entry.reject(Object.assign(new Error(frame.error.message), { code: frame.error.code }))
      return
    }
    // req/cancel from the child are not part of the host-side contract.
  }

  function spawnChild(): ChildProcess {
    const started = Date.now()
    const next = spawn(options.nodeExecutable ?? process.execPath, [entryPath], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: childEnv(),
    })
    child = next
    ready = undefined

    next.stdout!.setEncoding("utf8")
    next.stdout!.on("data", (chunk: string) => {
      stdoutBuffer += chunk
      let index: number
      while ((index = stdoutBuffer.indexOf("\n")) >= 0) {
        const line = stdoutBuffer.slice(0, index)
        stdoutBuffer = stdoutBuffer.slice(index + 1)
        const frame = parseFrame(line)
        if (frame !== undefined) handleFrame(frame)
      }
    })
    next.stderr!.setEncoding("utf8")
    next.stderr!.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-4000)
      for (const line of chunk.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (trimmed.length > 0) sinks.info("engine: " + trimmed.slice(0, 400))
      }
    })
    next.on("exit", (code, signal) => {
      if (child !== next) return
      child = null
      ready = undefined
      dropLedger(options.storageDir, next.pid ?? -1)
      failAllPending("E_DIED", "engine process exited (code " + String(code) + " signal " + String(signal) + ")")
      if (disposed) return
      const uptime = Date.now() - started
      if (uptime > STABLE_MS) attempts = 0
      if (!respawn || attempts >= BACKOFF_MS.length) {
        sinks.warn("engine-supervisor: engine exited and will not respawn (attempts " + String(attempts) + ")")
        return
      }
      const delay = BACKOFF_MS[attempts]
      attempts += 1
      sinks.warn("engine-supervisor: engine exited; respawning in " + String(delay) + "ms")
      respawnTimer = setTimeout(() => {
        respawnTimer = undefined
        void ensure().catch(() => { /* ensure narrates its own failure */ })
      }, delay)
      respawnTimer.unref()
    })
    if (next.pid !== undefined) {
      writeLedger(options.storageDir, { pid: next.pid, owner: process.pid, entry: entryPath, startedAt: new Date().toISOString() })
    }
    return next
  }

  async function ensure(): Promise<IpcReady> {
    if (disposed) throw new Error("engine-supervisor: disposed")
    if (child !== null && ready !== undefined) return ready
    spawnChild()
    const deadline = Date.now() + startupTimeoutMs
    while (Date.now() < deadline) {
      if (ready !== undefined) return ready
      if (child === null && !disposed) throw new Error("engine-supervisor: engine died during startup" + (stderrTail.length > 0 ? " — " + stderrTail.slice(-600) : ""))
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    }
    throw new Error("engine-supervisor: engine did not become ready in " + String(startupTimeoutMs) + "ms")
  }

  function request(method: string, params?: unknown, opts?: { timeoutMs?: number; signal?: unknown }): Promise<unknown> {
    if (child === null || ready === undefined) {
      return Promise.reject(Object.assign(new Error("engine-supervisor: engine not ready"), { code: "E_DIED" }))
    }
    const id = nextId++
    const timeoutMs = opts?.timeoutMs ?? 30000
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(Object.assign(new Error("engine request " + method + " timed out"), { code: "E_TIMEOUT" }))
      }, timeoutMs)
      timer.unref()
      pending.set(id, { resolve, reject, timer })
      child!.stdin!.write(encodeFrame({ t: "req", id, method, ...(params === undefined ? {} : { params }) }) + "\n")
      // Cancellation bridge (P3.8): the caller's signal travels as a cancel
      // frame; the engine aborts what it can and answers E_CANCELLED.
      const signal = opts?.signal
      if (signal !== null && signal !== undefined && typeof (signal as AbortSignal).addEventListener === "function") {
        (signal as AbortSignal).addEventListener("abort", () => {
          if (pending.delete(id)) {
            clearTimeout(timer)
            child?.stdin?.write(encodeFrame({ t: "cancel", id }) + "\n")
          }
        }, { once: true })
      }
    })
  }

  async function dispose(): Promise<void> {
    disposed = true
    if (respawnTimer !== undefined) clearTimeout(respawnTimer)
    const dying = child
    if (dying === null) return
    child = null
    try {
      await request("engine.shutdown", undefined, { timeoutMs: 8000 })
    } catch {
      // Not ready or already gone — the exit wait + tree-kill below is the floor.
    }
    const exited = new Promise<void>((resolve) => {
      dying.once("exit", () => resolve())
      setTimeout(() => resolve(), 5000).unref()
    })
    // The request above may have raced a dead pipe; nudge stdin closed so a
    // child waiting on EOF also exits.
    try { dying.stdin?.end() } catch { /* already closed */ }
    await exited
    if (dying.exitCode === null && dying.signalCode === null) await treeKill(dying.pid ?? -1)
    if (dying.pid !== undefined) dropLedger(options.storageDir, dying.pid)
    failAllPending("E_CANCELLED", "engine supervisor disposed")
  }

  return {
    ensure,
    async resume() { disposed = false; return ensure() },
    request,
    onEvent(handler) {
      eventHandlers.add(handler)
      return () => eventHandlers.delete(handler)
    },
    httpOrigin(): string | undefined {
      return ready !== undefined && (ready.httpPort ?? 0) > 0 ? "http://127.0.0.1:" + String(ready.httpPort) : undefined
    },
    alive: () => child !== null,
    epoch(): string | undefined {
      return ready === undefined ? undefined : String(ready.pid)
    },
    dispose,
  }
}
