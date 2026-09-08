/**
 * Machine-bound secret sealing for the adapter.
 *
 * Anything secret this plugin persists must be UNUSABLE when its files are
 * copied to another machine (or under another user) - the copy is ciphertext,
 * nothing more. Windows uses DPAPI (CurrentUser) with an app entropy string
 * through a short-lived powershell helper - the same technique
 * local-mcp-gateway uses for its master key; other platforms fall back to
 * AES-256-GCM keyed by sha256(machine id + app string). No plaintext secret
 * is ever written: the store file holds only
 * { version, entries: { <name>: { alg, createdAt, iv, blob } } }.
 *
 * @module dsh-mcp-adapter/sealed
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const APP = 'dsh-mcp-json-adapter/v1'
const STORE_VERSION = 1

/** One persisted secret: algorithm, nonce material, and the ciphertext. */
export interface SealedEntry {
  alg: 'dpapi' | 'machine'
  iv: string
  blob: string
  createdAt?: string
}

/** The whole store file's 'entries' mapping. */
export type SealedEntries = Record<string, SealedEntry>

export function sealedStorePath(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'mcp-json-adapter', 'sealed.json')
}

function sh(cmd: string, args: string[], input?: string, envExtra?: Record<string, string>): string {
  return execFileSync(cmd, args, {
    input,
    encoding: 'utf8',
    ...(envExtra === undefined ? {} : { env: { ...process.env, ...envExtra } }),
    stdio: input === undefined ? ['ignore', 'pipe', 'ignore'] : ['pipe', 'pipe', 'ignore'],
    timeout: 15000,
    windowsHide: true,
  }).trim()
}

function hasDpapi(): boolean {
  return process.platform === 'win32'
}

function dpapiProtect(plain: string): string {
  // The plaintext travels as base64 through the child ENVIRONMENT, never
  // through stdin: PowerShell decodes piped stdin with the console input
  // codepage (GBK on a Chinese Windows), silently corrupting non-ASCII
  // secrets. Base64 is codepage-proof in both directions.
  const script = [
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System.Security',
    "$plain = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:DSH_SEALED_IN))",
    "$blob = [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($plain), [Text.Encoding]::UTF8.GetBytes('" + APP + "'), 'CurrentUser')",
    '[Convert]::ToBase64String($blob)',
  ].join('; ')
  return sh('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], undefined, {
    DSH_SEALED_IN: Buffer.from(plain, 'utf8').toString('base64'),
  })
}

function dpapiUnprotect(b64: string): string {
  // The plaintext comes back as base64 on stdout for the same codepage
  // reason as dpapiProtect: PowerShell writes strings to a piped stdout
  // with the console output codepage, which corrupts non-ASCII secrets.
  const script = [
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System.Security',
    "$blob = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String('" + b64 + "'), [Text.Encoding]::UTF8.GetBytes('" + APP + "'), 'CurrentUser')",
    '[Convert]::ToBase64String($blob)',
  ].join('; ')
  const out = sh('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
  return Buffer.from(out, 'base64').toString('utf8')
}

function machineId(): string | undefined {
  try {
    if (process.platform === 'win32') {
      const out = sh('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'])
      const match = out.match(/MachineGuid\s+REG_SZ\s+(\S+)/)
      if (match !== null) return match[1]
    } else if (process.platform === 'darwin') {
      const out = sh('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'])
      const match = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)
      if (match !== null) return match[1]
    } else {
      const text = readFileSync('/etc/machine-id', 'utf8').trim()
      if (text.length > 0) return text
    }
  } catch {
    // no machine id means the fallback layer refuses to seal
  }
  return undefined
}

function fallbackKey(): Buffer {
  const id = machineId()
  if (id === undefined) throw new Error('sealed: no machine id available for the fallback layer')
  return createHash('sha256').update(APP + '\0' + id).digest()
}

export function seal(plain: string): SealedEntry {
  if (hasDpapi()) {
    return { alg: 'dpapi', iv: '', blob: dpapiProtect(plain) }
  }
  const key = fallbackKey()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const blob = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final(), cipher.getAuthTag()])
  return { alg: 'machine', iv: iv.toString('base64'), blob: blob.toString('base64') }
}

export function open(entry: SealedEntry): string {
  if (entry === null || typeof entry !== 'object' || typeof entry.blob !== 'string') {
    throw new Error('sealed: malformed entry')
  }
  if (entry.alg === 'dpapi') return dpapiUnprotect(entry.blob)
  if (entry.alg === 'machine') {
    const key = fallbackKey()
    const iv = Buffer.from(String(entry.iv), 'base64')
    const raw = Buffer.from(entry.blob, 'base64')
    const tag = raw.subarray(raw.length - 16)
    const body = raw.subarray(0, raw.length - 16)
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
  }
  throw new Error('sealed: unknown alg ' + String(entry.alg))
}

export function readStore(path = sealedStorePath()): SealedEntries {
  if (!existsSync(path)) return {}
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  if (parsed === null || typeof parsed !== 'object' || parsed.version !== STORE_VERSION || typeof parsed.entries !== 'object' || parsed.entries === null) {
    throw new Error('sealed: ' + path + ' is not a version-' + String(STORE_VERSION) + ' sealed store')
  }
  return parsed.entries
}

export function writeStore(entries: SealedEntries, path = sealedStorePath()): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ version: STORE_VERSION, entries }, null, 2) + '\n', { mode: 0o600 })
}

export function openSecret(name: string, path = sealedStorePath()): string | undefined {
  let entries: SealedEntries
  try {
    entries = readStore(path)
  } catch {
    return undefined
  }
  const entry = entries[name]
  if (entry === undefined) return undefined
  try {
    return open(entry)
  } catch {
    return undefined
  }
}

export function putSecret(name: string, plain: string, path = sealedStorePath()): void {
  let entries: SealedEntries
  try {
    entries = readStore(path)
  } catch {
    entries = {}
  }
  entries[name] = { ...seal(plain), createdAt: new Date().toISOString() }
  writeStore(entries, path)
}
