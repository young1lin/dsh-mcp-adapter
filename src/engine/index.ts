#!/usr/bin/env node
import { createEngine } from "./engine-main.js";
import { log } from "./log.js";
import { loginPath } from "./pathenv.js";
import type { Engine } from "./engine-main.js";

/**
 * The STANDALONE gateway entry (dist/engine/index.js): the explicit lifecycle of
 * engine-main.ts wrapped in the process-global set an OS-level process owns —
 * PATH repair, signal handling, exit codes, and the boot orphan sweep. A host
 * embedding the engine (the dsh plugin) imports createEngine directly and owns
 * those effects itself; nothing process-global lives in engine-main.ts.
 */
async function main() {
  // A detached start (and an agent shell) often inherit a PATH missing the
  // user-level bins (uv/uvx in ~/.local/bin, %APPDATA%\npm). Put them back
  // before any proc MCP spawns.
  process.env.PATH = loginPath();

  const engine: Engine = await createEngine({
    seedFirstRun: true,
    reapOrphans: true,
    importForwardPortOnFresh: true,
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("info", "shutting down");
    try {
      // dispose() covers: stop accepting + drop connections, tunnels down (enabled
      // flags preserved), adapters closed, call log + traffic tail flushed. The
      // hard 3s cap inside rejects rather than exiting; map that to exit(1).
      await engine.dispose();
      process.exit(0);
    } catch (err) {
      log("error", "shutdown timed out", { err: (err as Error).message });
      process.exit(1);
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  log("error", "fatal", { err: err.message });
  process.exit(1);
});
