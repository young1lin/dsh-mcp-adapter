/**
 * A REAL connection test against one definition, shared by the legacy admin
 * route (POST /api/mcps/test) and the private IPC method the dsh panel calls
 * (mcp.test). Extracted so both entry points probe identically — a "Test"
 * button that disagrees with what starting the MCP actually does is worse
 * than no button.
 *
 * Every branch is capped at TEST_TIMEOUT_MS: the SDK's own connect timeout is
 * ~60s and Mongo server-selection ~30s, and a dead remote must not hold the
 * button that long.
 *
 * @module dsh-mcp-adapter/engine/conn-test
 */

import { makeAdapter } from "./adapters/factory.js";
import { assertProxyUrl, proxiedFetch } from "./adapters/proxy-fetch.js";
import type { ServerDef } from "./config.js";

/** The types that have a probe. Anything else has nothing meaningful to test. */
export const TESTABLE_TYPES = ["mysql", "redis", "pg", "mongo", "http", "rest"] as const;

export const TEST_TIMEOUT_MS = 5000;

export interface ConnTestResult {
  ok: boolean;
  ms: number;
  /** HTTP status, for the rest branch only. */
  status?: number;
  /** The driver's own message, which is the useful part. */
  error?: string;
}

export function isTestable(type: string): boolean {
  return (TESTABLE_TYPES as readonly string[]).includes(type);
}

/** Reject a promise once the cap elapses, without holding the event loop open. */
function capped<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
      timer.unref();
    }),
  ]);
}

/**
 * Probe one definition. Throws only when the definition itself is unusable
 * (unknown type, adapter constructor refuses it); a connection that simply
 * fails comes back as { ok: false, error } so the caller can show it.
 *
 * - rest: one plain GET to baseUrl (through the def's proxy when it names
 *   one). ANY HTTP answer counts as reachable — the base path need not serve
 *   anything — but a network error does not. Its tools are authored calls
 *   into a metered API and must never fire on a button press.
 * - http: the initialize handshake IS the test, so a wrong URL or a rejected
 *   key fails here.
 * - databases: the adapter's own ping.
 */
export async function testConnection(def: ServerDef, timeoutMs = TEST_TIMEOUT_MS): Promise<ConnTestResult> {
  const type = String(def.type ?? "");
  if (!isTestable(type)) {
    throw new Error(`no connection test for type '${type}' (testable: ${TESTABLE_TYPES.join(" | ")})`);
  }
  const t0 = Date.now();

  if (type === "rest") {
    const headers = { accept: "application/json", ...((def.headers as Record<string, string>) ?? {}) };
    let doFetch: typeof fetch = fetch;
    try {
      // assertProxyUrl throws SYNCHRONOUSLY on a malformed proxy — inside the
      // try, where an invalid proxy reads like every other rest failure.
      if (typeof def.proxy === "string" && def.proxy) doFetch = proxiedFetch(assertProxyUrl(def.proxy));
      const out = await doFetch(String(def.baseUrl), {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { ok: true, ms: Date.now() - t0, status: out.status };
    } catch (err) {
      return { ok: false, ms: Date.now() - t0, error: (err as Error).message };
    }
  }

  const adapter = makeAdapter(def, "test");
  try {
    if (type === "http") await capped(adapter.build(), timeoutMs);
    else {
      if (!adapter.ping) throw new Error("this adapter has no connection probe");
      await capped(adapter.ping(), timeoutMs);
    }
    return { ok: true, ms: Date.now() - t0 };
  } catch (err) {
    // Driver errors never embed the password, so they are safe verbatim.
    return { ok: false, ms: Date.now() - t0, error: (err as Error).message };
  } finally {
    void adapter.close?.().catch(() => { /* best effort */ });
  }
}
