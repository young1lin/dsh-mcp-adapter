#!/usr/bin/env node
/**
 * The plugin-owned engine child entry: createEngine() with the host's knobs,
 * then the framed IPC service on stdio. The dsh plugin spawns this file;
 * nothing here runs in the host process.
 *
 * Environment contract (set by the host supervisor):
 *   MCP_GATEWAY_HOME       the plugin-private data dir (mcp-manager/engine)
 *   MCP_GATEWAY_MASTER_KEY 64-hex key the host sealed; binds all engine state
 *                           files to THIS plugin instance's key
 *   DSH_MCP_OWNER          the host PID, for orphan identification
 *
 * stdout is the IPC channel exclusively: the engine's own log() writes JSON
 * lines to console.log, so console.log is redirected to stderr for the
 * process's whole lifetime — one seam, established before anything logs.
 *
 * @module dsh-mcp-adapter/engine/ipc-main
 */

import { createEngine } from "./engine-main.js";
import { serveIpc, readyFrame } from "./ipc-service.js";
import { encodeFrame } from "../shared/ipc-protocol.js";
import { log } from "./log.js";

// stdout belongs to IPC; every log line (the engine's own log() included) goes
// to stderr, which the host forwards into its log with an engine: prefix.
console.log = (...args: unknown[]) => { console.error(...args) }

async function main(): Promise<void> {
  // Defense in depth: this plugin child is IPC-only even if a stale host
  // config or inherited environment asks to publish a listener.
  const engine = await createEngine({
    port: 0,
    privateMode: true,
    publicMcp: false,
    seedFirstRun: true,        // the plugin's engine dir is first-run seeded
  })

  const version = await readVersion()
  process.stdout.write(encodeFrame(readyFrame(version, process.pid, engine.port)) + "\n")

  const stopped = serveIpc(engine, { input: process.stdin, output: process.stdout }, (line) => log("info", line, {}))

  // The host died without asking: stdio ends, dispose gracefully, exit 0.
  await stopped
  log("info", "ipc channel closed — disposing", {})
  try {
    await engine.dispose()
  } catch {
    /* the 3s cap inside already did its best */
  }
  process.exit(0)
}

async function readVersion(): Promise<string> {
  try {
    const pkg = await import("../../package.json", { with: { type: "json" } })
    return String((pkg.default as { version?: string }).version ?? "0.0.0")
  } catch {
    return "0.0.0"
  }
}

main().catch((err) => {
  // A boot failure must reach the host as a frame, not just a dead pipe.
  const message = err instanceof Error ? err.message : String(err)
  try {
    process.stdout.write(encodeFrame({ t: "res", id: 0, ok: false, error: { code: "E_ENGINE_STATE", message: "engine boot failed: " + message } }) + "\n")
  } catch { /* pipe already gone */ }
  console.error(JSON.stringify({ level: "error", msg: "fatal", extra: { err: message } }))
  process.exit(1)
})
