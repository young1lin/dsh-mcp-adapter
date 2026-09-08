/**
 * Embedded gateway process: the plugin OWNS the 19999 server.
 *
 * Instead of assuming 'someone started lmg', activation health-probes the
 * configured gateway URL: an instance already answering is ATTACHED to
 * (shared machine resource - not ours to kill); otherwise the plugin spawns
 * the gateway server as a managed child -
 *
 *   node --max-semi-space-size=2 --max-old-space-size=256 <entry>
 *
 * - the same recipe 'lmg start' daemonizes with, minus the detach - and
 * supervises it: stdout/stderr flow into the host log prefixed 'gateway:',
 * an unexpected exit respawns with backoff (bounded), and plugin dispose
 * stops the process GRACEFULLY through POST /api/shutdown (which runs the
 * gateway's own SIGTERM path: adapters closed, proc children tree-killed,
 * call log flushed) before any hard kill.
 *
 * 'leaveRunning' hands ownership back on dispose: the child is detached and
 * survives dsh, for machines where other clients share this gateway.
 *
 * @module dsh-mcp-adapter/embed
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { probeHealth } from './gateway.js'
import type { EmbedConfig, GatewayConfig } from './gateway.js'

/** V8 flags 'lmg start' tunes the server with (measured ~15MB RSS win). */
const V8_FLAGS = ['--max-semi-space-size=2', '--max-old-space-size=256']

/** Respawn backoff schedule (ms); the counter resets after STABLE_MS up. */
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000]
const STABLE_MS = 60000

/** The supervisor handle createEmbed returns. */
export interface EmbedSupervisor {
  ensure(): Promise<boolean>
  dispose(): Promise<void>
  owned(): boolean
}

/** One located gateway installation. */
interface LocatedEntry {
  entry: string
}

/**
 * Find the gateway server entry (dist/index.js): explicit config, the
 * DSH_MCP_GATEWAY_ENTRY env var, the Windows global npm layout, and an
 * 'npm root -g' probe (cached) cover the realistic installs.
 * @param embed - resolved embed config.
 * @returns null when nothing located.
 */
export async function locateGatewayEntry(embed: EmbedConfig): Promise<LocatedEntry | null> {
  if (typeof embed.entry === 'string' && embed.entry.length > 0) {
    return { entry: embed.entry }
  }
  if (typeof process.env.DSH_MCP_GATEWAY_ENTRY === 'string' && process.env.DSH_MCP_GATEWAY_ENTRY.length > 0) {
    return { entry: process.env.DSH_MCP_GATEWAY_ENTRY }
  }
  const candidates: string[] = []
  if (process.platform === 'win32' && typeof process.env.APPDATA === 'string') {
    candidates.push(join(process.env.APPDATA, 'npm', 'node_modules', 'local-mcp-gateway', 'dist', 'index.js'))
  }
  const npmRoot = await npmGlobalRoot()
  if (npmRoot !== undefined) {
    candidates.push(join(npmRoot, 'local-mcp-gateway', 'dist', 'index.js'))
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return { entry: candidate }
  }
  return null
}

/** Cached 'npm root -g' answer (one spawn, ever). */
let npmRootCache: Promise<string | undefined> | undefined

function npmGlobalRoot(): Promise<string | undefined> {
  npmRootCache ??= new Promise((resolvePromise) => {
    const child = spawn('npm', ['root', '-g'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    let out = ''
    child.stdout.on('data', (chunk) => { out += String(chunk) })
    child.on('error', () => resolvePromise(undefined))
    child.on('exit', () => {
      const trimmed = out.trim()
      resolvePromise(trimmed.length > 0 ? trimmed : undefined)
    })
    setTimeout(() => resolvePromise(undefined), 10000).unref()
  })
  return npmRootCache
}

/**
 * The port a gateway URL names (19999 when none is written).
 * @param url - gateway origin.
 */
export function portOf(url: string): number {
  try {
    return Number(new URL(url).port) || 19999
  } catch {
    return 19999
  }
}

/**
 * Build the embed supervisor for one gateway config.
 * @param gateway - resolved gateway config with a non-null embed block (the
 *   only shape apply() constructs a supervisor for).
 * @param log - info sink.
 * @param warn - warning sink (defaults to the info sink).
 * @returns the supervisor; call ensure() to (re)start, dispose() to stop.
 */
export function createEmbed(gateway: GatewayConfig & { embed: EmbedConfig }, log: (line: string) => void, warn?: (line: string) => void): EmbedSupervisor {
  const warnSink = warn ?? log
  const port = portOf(gateway.url)
  let child: ChildProcess | null = null
  let disposed = false
  let attempts = 0
  let respawnTimer: NodeJS.Timeout | undefined
  let shuttingDown = false

  function forward(stream: NodeJS.ReadableStream, severity: (line: string) => void): void {
    let buffer = ''
    stream.on('data', (chunk) => {
      buffer += String(chunk)
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line.length > 0) severity('gateway: ' + line.slice(0, 400))
      }
    })
  }

  async function ensure(): Promise<boolean> {
    if (disposed) return false
    if (await probeHealth(gateway.url, gateway.fetchTimeoutMs)) return true
    const located = await locateGatewayEntry(gateway.embed)
    if (located === null) {
      warnSink('gateway: no local-mcp-gateway installation found for embed; set gateway.embed.entry')
      return false
    }
    if (child === null) {
      log('gateway: spawning embedded server ' + located.entry + ' on port ' + String(port))
      spawnChild(located.entry)
    }
    const deadline = Date.now() + (gateway.embed.startupTimeoutMs ?? 20000)
    while (Date.now() < deadline) {
      if (await probeHealth(gateway.url, 1000)) return true
      if (child === null && !disposed) {
        // The child died while starting (EADDRINUSE against a foreign
        // instance is the usual cause); one more health check decides.
        if (await probeHealth(gateway.url, 1000)) return true
        return false
      }
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 300))
    }
    return await probeHealth(gateway.url, 1000)
  }

  function spawnChild(entry: string): void {
    const startedAt = Date.now()
    const next = spawn(process.execPath, [...V8_FLAGS, entry], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, MCP_GATEWAY_PORT: String(port) },
    })
    child = next
    shuttingDown = false
    forward(next.stdout!, log)
    forward(next.stderr!, warnSink)
    next.on('exit', async (code, signal) => {
      if (child !== next) return
      child = null
      const uptime = Date.now() - startedAt
      if (uptime > STABLE_MS) attempts = 0
      if (disposed || shuttingDown) return
      if (!gateway.embed.respawn || attempts >= BACKOFF_MS.length) {
        warnSink('gateway: embedded process exited (code ' + String(code) + ' signal ' + String(signal) + '); not respawning')
        return
      }
      const delay = BACKOFF_MS[attempts]
      attempts += 1
      warnSink('gateway: embedded process exited (code ' + String(code) + ' signal ' + String(signal) + '); respawning in ' + String(delay) + 'ms')
      respawnTimer = setTimeout(() => {
        respawnTimer = undefined
        void ensure().catch(() => {})
      }, delay)
      respawnTimer.unref()
    })
  }

  async function requestShutdown(): Promise<void> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    timer.unref()
    try {
      await fetch(gateway.url + '/api/shutdown', { method: 'POST', signal: controller.signal })
    } catch {
      // Already down or refusing - the hard-kill fallback follows.
    } finally {
      clearTimeout(timer)
    }
  }

  async function waitForExit(ms: number): Promise<boolean> {
    const deadline = Date.now() + ms
    while (child !== null && Date.now() < deadline) {
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 200))
    }
    return child === null
  }

  function hardKill(): void {
    const target = child
    if (target === null) return
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(target.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      killer.on('error', () => { target.kill('SIGKILL') })
    } else {
      target.kill('SIGKILL')
    }
  }

  async function dispose(): Promise<void> {
    disposed = true
    if (respawnTimer !== undefined) clearTimeout(respawnTimer)
    if (child === null) return
    if (gateway.embed.leaveRunning) {
      log('gateway: leaving the embedded process running (leaveRunning)')
      child.unref()
      child = null
      return
    }
    shuttingDown = true
    log('gateway: stopping embedded process')
    await requestShutdown()
    if (!(await waitForExit(5000))) hardKill()
    await waitForExit(3000)
    child = null
  }

  return {
    ensure,
    dispose,
    owned: () => child !== null,
  }
}
