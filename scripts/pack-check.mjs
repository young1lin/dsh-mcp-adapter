/**
 * P1.6 clean-install check: npm pack this repo, install the tarball into an
 * EMPTY temp directory (no adjacent source, no global gateway, devDeps
 * omitted), then drive the packaged plugin-owned engine end to end: spawn,
 * handshake, bearer, and a real MCP tools/call against the seeded echo server
 * over the engine's loopback HTTP surface.
 *
 * Exit 0 = the shipped artifact is self-contained. Run from the repo root:
 *   node scripts/pack-check.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
// Node >=18.20 refuses to spawn .cmd/.bat without a shell; drive npm through
// its cli entry beside the running node binary instead — no shell, no quoting games.
const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const npmArgs = (args) => [npmCli, ...args];

console.log("[pack] npm pack ...");
const listing = JSON.parse(execFileSync(process.execPath, npmArgs(["pack", "--json"]), { cwd: repo, encoding: "utf8", windowsHide: true }));
const tarball = listing[0].filename;

const stage = mkdtempSync(join(tmpdir(), "mcp-pack-check-"));
try {
  const app = join(stage, "app");
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "pack-check", private: true, type: "module" }, null, 2));
  console.log("[pack] installing tarball into an isolated dir (prod deps only) ...");
  execFileSync(process.execPath, npmArgs(["install", "--no-audit", "--no-fund", "--omit=dev", join(repo, tarball)]), {
    cwd: app, stdio: "inherit", windowsHide: true,
  });

  const storage = join(stage, "storage");
  const driver = join(stage, "driver.mjs");
  copyFileSync(fileURLToPath(new URL("./pack-check-driver.mjs", import.meta.url)), driver);
  console.log("[pack] driving the installed engine end to end ...");
  execFileSync(process.execPath, [driver, app, storage], { stdio: "inherit", windowsHide: true });
  console.log("[pack] OK: the clean install hosts, starts, and serves MCP.");
} finally {
  rmSync(stage, { recursive: true, force: true });
}
