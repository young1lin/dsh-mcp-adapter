import { config } from "dotenv";
import { afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

config();

/**
 * One temp sandbox per test file, removed when that file is done.
 *
 * TMPDIR/TMP/TEMP are redirected INTO it, so every `tmpdir()` in the suite —
 * this file's, each test's own mkdtemp, and anything the tests spawn — lands
 * inside and goes with it. Cleaning up per call site is the version that did
 * not hold: eight engine test files create directories they never remove, and
 * the machine's %TEMP% ended up with thousands of `mcpgw-*` leftovers, some
 * still holding a listening port. `os.tmpdir()` re-reads these variables on
 * every call, so redirecting them here is enough, and it keeps working for
 * test files nobody has written yet.
 */
const sandbox = mkdtempSync(join(tmpdir(), "mcpgw-test-"));
process.env.TMPDIR = sandbox;
process.env.TMP = sandbox;
process.env.TEMP = sandbox;

// Every gateway state file is sealed with a machine-bound master key. Tests pin the key
// explicitly so the suite never spawns powershell / security / secret-tool, and pin an isolated
// data dir so no test (some of which migrate plaintext files by reading them) can ever touch the
// real ~/.mcp-gateway on the machine running the suite.
process.env.MCP_GATEWAY_MASTER_KEY = "ab".repeat(32);
process.env.MCP_GATEWAY_HOME = mkdtempSync(join(sandbox, "mcpgw-test-home-"));

let swept = false;

function sweep(): void {
  if (swept) return;
  swept = true;
  // Best effort, with retries: on Windows a detached daemon that outlived its
  // test can still hold its log file open, and failing to tidy up must never be
  // the reason a green run reports red.
  try {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (err) {
    // Say so. A silent catch here is exactly how 5,703 leftovers accumulated
    // without anyone ever noticing they were being created.
    console.warn(`temp sandbox not removed: ${sandbox} (${(err as { code?: string }).code ?? String(err)})`);
  }
}

afterAll(sweep);
// The floor. Three of 55 files kept their sandbox with no cleanup error to
// show for it, so the hook itself does not always run — and process exit is the
// one moment that always arrives. rmSync on an already-removed path is a no-op,
// so the two paths cost nothing when both fire.
process.on("exit", sweep);
