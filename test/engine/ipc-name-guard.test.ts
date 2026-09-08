import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADMIN_METHODS } from "../../src/engine/ipc-admin.js";
import { setCallLogDir } from "../../src/engine/calls.js";

/**
 * Instance names are checked at the IPC boundary, because past it they are path segments.
 *
 * `mcp.clearCalls` was the one method in this family without the check, and it is also the only one
 * that DELETES: clearCalls does `rm(bodyDir(name), { recursive: true, force: true })`. The bridge
 * route in front of it takes the name from `url.pathname`, which leaves `%2F` encoded, so
 * `DELETE /dsh-mcp-manager/mcp/..%2F..%2Fx/calls` matched the `([^/]+)` segment and arrived here
 * decoded as `../../x`. The whole family is pinned here so the next method to take a name has a
 * failing test rather than a rediscovery.
 */

const NAME_METHODS = ["mcp.calls", "mcp.callDetail", "mcp.callSources", "mcp.clearCalls", "mcp.toolHistory"];

const call = (method: string, params: unknown): Promise<unknown> =>
  ADMIN_METHODS[method]!({} as never, params, new AbortController().signal);

describe("instance names at the IPC boundary", () => {
  for (const method of NAME_METHODS) {
    it(`${method} refuses anything that is not a bare instance name`, async () => {
      // Traversal, separators, empty, and over the 63-character cap.
      for (const name of ["../../victim", "..", "a/b", "", "x".repeat(64)]) {
        await expect(
          call(method, { name, tool: "t", seq: 1 }),
          `${method} accepted ${JSON.stringify(name)}`,
        ).rejects.toThrow("invalid instance name");
      }
    });
  }

  it("mcp.clearCalls cannot reach a directory outside the call log", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcpgw-nameguard-"));
    const logs = join(root, "logs");
    const victim = join(root, "victim");
    mkdirSync(logs, { recursive: true });
    mkdirSync(victim, { recursive: true });
    writeFileSync(join(victim, "keep.txt"), "not yours to delete");
    setCallLogDir(logs);
    try {
      // bodyDir() is <logs>/bodies/<name>, so this resolves to the victim beside the log root.
      // Asserting the refusal AND the survivor together is deliberate: without the guard the
      // failure reads { outcome: "accepted", victimSurvived: false }, which is the whole bug in
      // one line rather than merely a missing throw.
      const outcome = await call("mcp.clearCalls", { name: "../../victim" })
        .then(() => "accepted", (err: Error) => err.message);
      expect({ outcome, victimSurvived: existsSync(join(victim, "keep.txt")) })
        .toEqual({ outcome: "invalid instance name", victimSurvived: true });
      // And the ordinary case still works, so the guard is a filter and not a wall.
      await expect(call("mcp.clearCalls", { name: "well-formed_1" })).resolves.toEqual({ ok: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
