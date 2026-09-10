/**
 * The embeddable Engine: local-mcp-gateway's runtime core behind an explicit
 * start()/dispose() lifecycle, with every process-level side effect left OUT.
 *
 * What a host embedding this module must own itself is exactly the
 * process-global set:
 *   - process.env.PATH login-path repair (see pathenv.ts; a host plugin usually
 *     inherits a sane PATH already — proc.ts repairs it per spawn),
 *   - SIGINT/SIGTERM handlers + process.exit sequencing,
 *   - child-process hygiene: the host supervisor tree-kills the engine (and
 *     with it every hosted MCP) and keeps its own engine-orphan ledger,
 *   - first-run seeding of the data dir (`seedFirstRun` default false; the
 *     plugin's ipc-main.ts entry opts in for its private engine dir).
 *
 * Importing this module has NO process side effects: the adapter-factory
 * registrations in ./adapters/factory.ts are in-memory and idempotent, and
 * nothing here touches env, signals or the filesystem until start().
 *
 * @module dsh-mcp-adapter/engine
 */

import { buildApp } from "./router.js";
import { loadConfig } from "./config.js";
import { log } from "./log.js";
import { flushCalls, startCallRetention } from "./calls.js";
import { Registry, isLazy } from "./registry.js";
import { ManagedStore, loadManagedToken } from "./managed.js";
import { TokenManager } from "./token.js";
import { makeAdapter } from "./adapters/factory.js";
import { ensureFirstRun } from "./bootstrap.js";
import { dataPath } from "./datadir.js";
import { logicalKeyOf } from "../shared/instance-name.js";
import type { Server as HttpServer } from "node:http";

/** Options createEngine accepts; every knob has a host-friendly default. */
export interface EngineOptions {
  /** Plugin mode: no compatibility dashboard or implicit config servers. */
  privateMode?: boolean;
  /** Explicit external MCP listener; never enabled implicitly in private mode. */
  publicMcp?: boolean;
  publicNames?: string[];
  /** Listen port override (MCP_GATEWAY_PORT / config file resolution otherwise). */
  port?: number;
  /** Seed the data dir on first run (standalone behavior). Default false. */
  seedFirstRun?: boolean;
  /** Hard cap on the whole dispose sequence; a wedged driver rejects instead of exiting. */
  disposeTimeoutMs?: number;
}

/** A running engine: its live handles and the one dispose() that tears it all down. */
export interface Engine {
  readonly port: number;
  readonly host: string;
  readonly registry: Registry;
  readonly store: ManagedStore;
  readonly tokens: TokenManager;
  readonly server: HttpServer;
  /** Graceful shutdown. Rejects when the sequence exceeds disposeTimeoutMs. */
  dispose(): Promise<void>;
}

/**
 * Build and start one engine (overrides applied, lazy entries idle, retention
 * armed) minus the process-global effects documented on the module.
 * @param options - lifecycle knobs.
 * @returns the running engine handle.
 * @throws when the config is unusable or the listener cannot bind.
 */
export async function createEngine(options: EngineOptions = {}): Promise<Engine> {
  if (options.seedFirstRun !== false && options.seedFirstRun === true) ensureFirstRun();
  const cfg = loadConfig();
  const port = options.port ?? cfg.port;

  const registry = new Registry(15000);
  const store = new ManagedStore(dataPath("managed.json"));

  for (const [name, def] of Object.entries(options.privateMode ? {} : cfg.servers)) {
    try {
      // Same key the toggle endpoints write under (shared/instance-name): the ENTRY, so a
      // setting outlives both an edit to the server and the instance it was made on.
      def.disabledTools = store.disabledTools(logicalKeyOf(name));
      const adapter = makeAdapter(def, name);
      const r = store.resourceEnabled(logicalKeyOf(name));
      if (r !== undefined && adapter.resourceToggle) adapter.resourceToggle.on = r;
      registry.register(name, "config", def, adapter);
      const enabled = store.enabledFor(name) !== false;
      if (!enabled) log("info", "config mcp stays stopped (panel Stop)", { name, type: def.type });
      else if (isLazy(def)) log("info", "config mcp idle (starts on first request)", { name, type: def.type });
      else {
        await registry.start(name);
        log("info", "config mcp ready", { name, type: def.type });
      }
    } catch (err) {
      log("error", "config mcp init failed", { name, err: (err as Error).message });
    }
  }

  for (const m of options.privateMode ? [] : store.all()) {
    if (m.override && registry.has(m.name)) {
      try {
        // Seeded exactly as the other two branches do it: the toggles live in the store, not on the
        // def, so an adapter rebuilt without them comes back serving the tools the user turned off.
        m.def.disabledTools = store.disabledTools(logicalKeyOf(m.name));
        const adapter = makeAdapter(m.def, m.name);
        const r = store.resourceEnabled(logicalKeyOf(m.name));
        if (r !== undefined && adapter.resourceToggle) adapter.resourceToggle.on = r;
        await registry.updateDef(m.name, m.def, adapter, { start: m.enabled });
        log("info", "config mcp override applied", { name: m.name, type: m.def.type, enabled: m.enabled });
      } catch (err) {
        log("error", "config mcp override failed", { name: m.name, err: (err as Error).message });
      }
      continue;
    }
    if (registry.has(m.name)) continue;
    try {
      m.def.disabledTools = store.disabledTools(logicalKeyOf(m.name));
      const adapter = makeAdapter(m.def, m.name);
      const r = store.resourceEnabled(logicalKeyOf(m.name));
      if (r !== undefined && adapter.resourceToggle) adapter.resourceToggle.on = r;
      registry.register(m.name, "managed", m.def, adapter);
      if (m.enabled && !isLazy(m.def)) await registry.start(m.name);
      log("info", "managed mcp ready", { name: m.name, type: m.def.type, enabled: m.enabled });
    } catch (err) {
      log("error", "managed mcp init failed", { name: m.name, err: (err as Error).message });
    }
  }

  registry.startTimer();

  const tokens = new TokenManager(store, loadManagedToken(dataPath("managed.json")) ?? cfg.token);

  const app = buildApp(registry, tokens, cfg.tokenEnv,
    options.privateMode ? { publicNames: new Set(options.publicNames ?? []) } : {});
  const httpServer = app;
  const listening = !options.privateMode || options.publicMcp === true;
  if (listening) {
  app.listen(port, cfg.host, () => {
    log("info", "engine listening", { host: cfg.host, port, paths: registry.names() });
  });
  // A listen failure arrives as an 'error' EVENT, not a rejected promise — surface it
  // to the awaiting caller instead of letting the process die on an uncaught throw.
  const listenFailed = new Promise<never>((_, reject) => {
    httpServer.once("error", (err: NodeJS.ErrnoException) => reject(new Error(`listen ${cfg.host}:${port} failed: ${err.code ?? ""} ${err.message}`)));
  });
  await Promise.race([
    new Promise<void>((resolve) => httpServer.once("listening", () => resolve())),
    listenFailed,
  ]);
  }

  const stopRetention = startCallRetention();
  let shuttingDown = false;

  // With port 0 (ephemeral, the plugin-managed default) the ACTUAL bound port
  // comes from the listener's address, not from the requested number.
  const boundPort = (): number => {
    const addr = httpServer.address();
    return addr !== null && typeof addr === "object" ? addr.port : 0;
  };

  const dispose = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    registry.stopTimer();
    stopRetention();
    log("info", "engine disposing");
    const timeoutMs = options.disposeTimeoutMs ?? 3000;
    let timedOut = false;
    const guard = new Promise<never>((_, reject) => {
      const t = setTimeout(() => { timedOut = true; reject(new Error(`engine dispose exceeded ${timeoutMs}ms`)); }, timeoutMs);
      t.unref();
    });
    await Promise.race([
      (async () => {
        if (httpServer.listening) httpServer.close();
        httpServer.closeAllConnections();
        await registry.closeAll();
        await flushCalls();
      })(),
      guard,
    ]).catch((err) => {
      if (!timedOut) throw err;
      throw err;
    });
  };

  return {
    get port(): number { return boundPort(); },
    host: cfg.host,
    registry,
    store,
    tokens,
    server: httpServer,
    dispose,
  };
}
