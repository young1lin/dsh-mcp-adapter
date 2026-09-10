/**
 * A REAL connection test against one definition, shared by the private IPC
 * method the dsh panel calls (mcp.test). Extracted so the "Test" button
 * probes exactly what starting the MCP does — a button that disagrees with
 * startup is worse than no button.
 *
 * The http branch is capped at TEST_TIMEOUT_MS: the SDK's own connect timeout
 * is ~60s, and a dead remote must not hold the button that long.
 *
 * @module dsh-mcp-adapter/engine/conn-test
 */

import { makeAdapter } from "./adapters/factory.js";
import type { ServerDef } from "./config.js";

/** The types that have a probe. Anything else has nothing meaningful to test. */
export const TESTABLE_TYPES = ["http"] as const;

export const TEST_TIMEOUT_MS = 5000;

export interface ConnTestResult {
  ok: boolean;
  ms: number;
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
 * http: the initialize handshake IS the test, so a wrong URL or a rejected
 * key fails here.
 */
export async function testConnection(def: ServerDef, timeoutMs = TEST_TIMEOUT_MS): Promise<ConnTestResult> {
  const type = String(def.type ?? "");
  if (!isTestable(type)) {
    throw new Error(`no connection test for type '${type}' (testable: ${TESTABLE_TYPES.join(" | ")})`);
  }
  const t0 = Date.now();

  const adapter = makeAdapter(def, "test");
  try {
    await capped(adapter.build(), timeoutMs);
    return { ok: true, ms: Date.now() - t0 };
  } catch (err) {
    // Driver errors never embed the password, so they are safe verbatim.
    return { ok: false, ms: Date.now() - t0, error: (err as Error).message };
  } finally {
    void adapter.close?.().catch(() => { /* best effort */ });
  }
}
