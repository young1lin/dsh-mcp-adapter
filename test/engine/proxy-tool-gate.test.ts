import { describe, it, expect } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { makeProxyServer } from "../../src/engine/adapters/proxy.js";
import { ProcAdapter } from "../../src/engine/adapters/proc.js";
import { HttpAdapter } from "../../src/engine/adapters/http.js";

/**
 * Per-tool toggles on a PROXIED MCP (proc/http).
 *
 * These used to answer "tool toggles are not supported for MCP type 'proc'": the toggle was thought
 * to belong only to adapters owning a static, gateway-authored tool list, since proc and http merely
 * forward a remote's. That had it backwards — deciding which of a remote's tools to republish is
 * most of the reason to run a gateway in front of it, and the forwarding layer is exactly where the
 * decision can be enforced. So: filtered out of tools/list, and REFUSED at tools/call, because a
 * gate that only hides is a display preference.
 */

/** A remote that records what was actually asked of it, so "answered locally" is provable. */
function fakeRemote(opts: { tools?: string[]; nextCursor?: string } = {}) {
  const calls: string[] = [];
  const client = {
    listTools: async () => {
      calls.push("tools/list");
      return {
        tools: (opts.tools ?? ["alpha", "beta", "gamma"]).map((name) => ({
          name, description: name + " tool", inputSchema: { type: "object" },
        })),
        ...(opts.nextCursor ? { nextCursor: opts.nextCursor } : {}),
      };
    },
    callTool: async (params: { name: string }) => {
      calls.push("tools/call:" + params.name);
      return { content: [{ type: "text", text: "ran " + params.name }] };
    },
    listResources: async () => {
      calls.push("resources/list");
      return { resources: [{ uri: "file:///r", name: "r" }] };
    },
    readResource: async (params: { uri: string }) => {
      calls.push("resources/read");
      return { contents: [{ uri: params.uri, text: "body" }] };
    },
  } as unknown as Client;
  return { client, calls };
}

async function connect(server: ReturnType<typeof makeProxyServer>): Promise<Client> {
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" }, { capabilities: {} });
  await Promise.all([client.connect(c), server.connect(s)]);
  return client;
}

describe("proxied tool gate", () => {
  it("withholds disabled tools from tools/list and passes the rest through", async () => {
    const remote = fakeRemote();
    const toolToggle = { disabled: new Set(["beta"]) };
    const client = await connect(makeProxyServer(remote.client, { toolToggle }));

    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name)).toEqual(["alpha", "gamma"]);
    // The ones that survive are untouched — a gate, not a rewrite.
    expect(listed.tools[0]!.description).toBe("alpha tool");
  });

  it("is live: flipping the shared Set changes the next list, with no rebuild", async () => {
    const remote = fakeRemote();
    // The very Set the toggle API mutates in place, held by reference.
    const toolToggle = { disabled: new Set<string>() };
    const client = await connect(makeProxyServer(remote.client, { toolToggle }));

    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["alpha", "beta", "gamma"]);
    toolToggle.disabled.add("alpha");
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["beta", "gamma"]);
    toolToggle.disabled.delete("alpha");
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("keeps the remote's pagination cursor when a whole page is filtered away", async () => {
    // Filtering happens per page because the remote owns the pagination: an empty page that still
    // carries nextCursor is a page the client must keep walking, not the end of the list.
    const remote = fakeRemote({ tools: ["one", "two"], nextCursor: "p2" });
    const client = await connect(makeProxyServer(remote.client, {
      toolToggle: { disabled: new Set(["one", "two"]) },
    }));

    const listed = await client.listTools({ cursor: "p1" });
    expect(listed.tools).toEqual([]);
    expect(listed.nextCursor).toBe("p2");
  });

  it("refuses a call to a disabled tool without asking the remote", async () => {
    const remote = fakeRemote();
    const client = await connect(makeProxyServer(remote.client, {
      toolToggle: { disabled: new Set(["beta"]) },
    }));

    // Hidden must mean uncallable: a model that listed the tools before the switch moved still
    // holds the name, and the remote must never see the call.
    await expect(client.callTool({ name: "beta", arguments: {} } as never)).rejects.toThrow(/unknown tool: beta/);
    expect(remote.calls).not.toContain("tools/call:beta");

    // An enabled neighbour is unaffected.
    await client.callTool({ name: "alpha", arguments: {} } as never);
    expect(remote.calls).toContain("tools/call:alpha");
  });

  it("answers an off resources list locally, so a metered remote is never asked", async () => {
    const remote = fakeRemote();
    const resourceToggle = { on: false };
    const client = await connect(makeProxyServer(remote.client, {
      resourceToggle, remoteCaps: { tools: {}, resources: {} },
    }));

    expect((await client.listResources()).resources).toEqual([]);
    expect(remote.calls).not.toContain("resources/list");

    // The capability stays announced while off — that is what lets the switch be flipped back on
    // without a restart (and what keeps list_changed legal).
    resourceToggle.on = true;
    expect((await client.listResources()).resources).toHaveLength(1);
    expect(remote.calls).toContain("resources/list");
  });

  it("refuses a READ while resources are off, so hiding the list is not the whole gate", async () => {
    const remote = fakeRemote();
    const resourceToggle = { on: false };
    const client = await connect(makeProxyServer(remote.client, {
      resourceToggle, remoteCaps: { tools: {}, resources: {} },
    }));

    // The list being empty is not a gate: a client that listed before the switch moved still holds
    // the URI, and guessing one costs nothing. Same shape as the tools/call refusal above.
    await expect(client.readResource({ uri: "file:///r" } as never))
      .rejects.toThrow("unknown resource: file:///r");
    expect(remote.calls).not.toContain("resources/read");

    resourceToggle.on = true;
    await client.readResource({ uri: "file:///r" } as never);
    expect(remote.calls).toContain("resources/read");
  });
});

describe("proxy adapters own the toggle", () => {
  it("ProcAdapter exposes a live tool toggle, seeded from what the store persisted", () => {
    const a = new ProcAdapter({ name: "z", command: "node -e 0", disabledTools: ["web_search"] });
    // This property being present is the whole of what mcp.setToolEnabled checks before it
    // answers "tool toggles are not supported for MCP type 'proc'".
    expect(a.toolToggle.disabled.has("web_search")).toBe(true);
    expect(a.resourceToggle.on).toBe(true);
  });

  it("ProcAdapter starts with resources off when the entry's config hid them", () => {
    const a = new ProcAdapter({ name: "z", command: "node -e 0", exposeResources: false });
    expect(a.resourceToggle.on).toBe(false);
    expect(a.toolToggle.disabled.size).toBe(0);
  });

  it("HttpAdapter has the same pair", () => {
    const a = new HttpAdapter({ name: "h", url: "https://example.invalid/mcp", disabledTools: ["dangerous"] });
    expect(a.toolToggle.disabled.has("dangerous")).toBe(true);
    expect(a.resourceToggle.on).toBe(true);
  });
});
