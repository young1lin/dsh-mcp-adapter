/**
 * The end-to-end driver, run against the INSTALLED package in an isolated app
 * dir (argv: <appDir> <storageDir>): supervisor -> engine -> bearer -> a real
 * MCP initialize + tools/call against the seeded echo server.
 */
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { createServer } from "node:net";

const appDir = process.argv[2];
const storageDir = process.argv[3];
const log = (line) => console.error("[driver] " + line);

// The tarball installs under the app's node_modules; deps hoist beside it.
const pkgDir = join(appDir, "node_modules", "dsh-mcp-adapter");
const { createEngineSupervisor } = await import(
  pathToFileURL(join(pkgDir, "dist", "runtime", "engine-supervisor.js")).href
);

// The engine defaults to privateMode (no HTTP listener) since P6.7; this
// check drives the loopback HTTP surface specifically, so reserve one free
// port up front and hand it to the child via MCP_GATEWAY_PORT.
const freePort = await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.on("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const port = probe.address().port;
    probe.close(() => resolve(port));
  });
});
log("reserved loopback port " + freePort);

const supervisor = createEngineSupervisor({ storageDir, httpPort: freePort, publicMcp: true, publicNames: ["echo"] }, { info: log, warn: log });
try {
  const ready = await supervisor.ensure();
  log("engine ready pid=" + ready.pid + " httpPort=" + ready.httpPort);

  const bearer = await supervisor.request("engine.bearer", undefined, { timeoutMs: 10000 });
  if (typeof bearer.secret !== "string" || bearer.secret.length === 0) throw new Error("no bearer secret");
  log("bearer resolved (id=" + bearer.id + ")");

  // Private mode hosts nothing from the seeded config (P6.7) — ensure the
  // echo MCP over IPC exactly like the plugin's ensure-on-demand does, so
  // the loopback HTTP surface below has a real endpoint to serve.
  const ensured = await supervisor.request("mcp.ensure", { name: "echo", def: { type: "echo" }, start: true }, { timeoutMs: 30000 });
  if (ensured.lifecycle !== "started") throw new Error("echo did not start: " + JSON.stringify(ensured));
  log("echo ensured over IPC (lifecycle=started)");

  const { Client, StreamableHTTPClientTransport } = await import(
    pathToFileURL(join(appDir, "node_modules", "@modelcontextprotocol", "client", "dist", "index.mjs")).href
  );
  const origin = "http://127.0.0.1:" + ready.httpPort;
  const transport = new StreamableHTTPClientTransport(new URL(origin + "/echo"), {
    requestInit: { headers: { Authorization: "Bearer " + bearer.secret } },
  });
  const client = new Client({ name: "pack-check", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  log("MCP initialize over streamable-http OK");

  const tools = await client.listTools();
  const echo = (tools.tools ?? []).find((t) => t.name === "echo");
  if (echo === undefined) throw new Error("echo tool not listed");
  const result = await client.callTool({ name: "echo", arguments: { msg: "clean install works" } });
  const text = (result.content ?? []).map((b) => b.text ?? "").join("");
  if (!text.includes("clean install works")) throw new Error("echo round-trip lost the text: " + text);
  log("echo tools/call round-trip OK: " + text.slice(0, 60));
  await client.close();
} finally {
  await supervisor.dispose();
  log("engine disposed");
}
