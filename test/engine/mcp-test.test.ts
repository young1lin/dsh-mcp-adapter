import { describe, it, expect, afterAll } from "vitest";
import type { Server as HttpServer } from "node:http";
import { buildApp } from "../../src/engine/router.js";
import { Registry } from "../../src/engine/registry.js";
import { echoAdapter } from "../../src/engine/adapters/echo.js";
import { singleTokenManager } from "../../src/engine/token.js";
import { ADMIN_METHODS } from "../../src/engine/ipc-admin.js";

const REMOTE_TOKEN = "remote-echo-token";
const registries: Registry[] = [];
const closers: Array<() => Promise<void>> = [];

/** A real bearer-gated streamable-HTTP MCP endpoint on an ephemeral port — the same shape the
 *  http-adapter tests use, so the http test path exercises a genuine initialize handshake. */
async function remoteEcho() {
  const reg = new Registry(60000);
  registries.push(reg);
  reg.register("echo", "config", { type: "echo" }, echoAdapter);
  await reg.start("echo");
  const server: HttpServer = buildApp(reg, singleTokenManager(REMOTE_TOKEN)).listen(0);
  const { port } = server.address() as { port: number };
  closers.push(async () => {
    server.closeAllConnections?.();
    server.close();
  });
  return { url: `http://127.0.0.1:${port}/echo` };
}

afterAll(async () => {
  for (const c of closers) await c();
  await Promise.all(registries.map((r) => r.closeAll()));
});

/** mcp.test ignores its engine handle (it probes a DRAFT definition), so a bare call is the
 *  real dispatch path: resolveDef + testConnection, exactly what the panel's Test button rides. */
const probe = (def: unknown) => ADMIN_METHODS["mcp.test"](undefined as never, { def }, undefined as never);

describe("mcp.test (the private IPC probe)", () => {
  it("refuses a type with no connection test, naming the testable ones", async () => {
    const out = await probe({ type: "proc", command: "x" });
    expect(out).toMatchObject({ testable: false, types: ["http"] });
  });

  it("http: a real initialize handshake — ok with the right key", async () => {
    const remote = await remoteEcho();
    const out = await probe({ type: "http", url: remote.url, headers: { Authorization: `Bearer ${REMOTE_TOKEN}` } });
    expect(out).toMatchObject({ testable: true, ok: true });
  });

  it("http: a wrong key fails the handshake honestly", async () => {
    const remote = await remoteEcho();
    const out = await probe({ type: "http", url: remote.url, headers: { Authorization: "Bearer not-the-key" } });
    expect(out).toMatchObject({ testable: true, ok: false });
    expect(String((out as { error?: string }).error)).toBeTruthy();
  });

  it("http: a network failure is a failure, with the connection's own error", async () => {
    const out = await probe({ type: "http", url: "http://127.0.0.1:1/mcp" });
    expect(out).toMatchObject({ testable: true, ok: false });
    expect(String((out as { error?: string }).error)).toMatch(/fetch|ECONN|refused/i);
  });

  it("a def without shape is refused before any probe runs", async () => {
    // A type this build no longer hosts reads as untestable, never as a crash.
    await expect(probe({ type: "mysql" })).resolves.toMatchObject({ testable: false });
    await expect(probe("nope")).rejects.toThrow(/definition required/);
  });
});
