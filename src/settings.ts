/**
 * GUI settings: the 'mcp-gateway' namespace over the gateway layer. The
 * Requests section in the dsh settings dialog edits this shape; the patch
 * config's 'gateway' block is the composition BASE layer the GUI edits on
 * top of, and this module owns the projection in both directions.
 *
 * @module dsh-mcp-adapter/settings
 */

import { DEFAULT_GATEWAY_URL, resolveGatewayConfig, type GatewayConfig } from './gateway.js'
import type { Context } from './cordis.js'

/** Settings namespace this plugin owns (lowercase hyphenated, per dsh-settings). */
export const SETTINGS_NAMESPACE = 'mcp-gateway'

/** The section shape stored in the settings document / edited by the GUI. */
export interface GatewaySection {
  enabled: boolean
  lifecycle: string
  url: string
  groups: string
  include: string
  exclude: string
  tokenLabel: string
  required: boolean
}

/** Chainable field builder schemastery hands back from boolean()/string(). */
export interface SchemaFieldBuilder {
  default(value: unknown): unknown
}

/** The schemastery builder surface the section schema needs. */
export interface SchemaBuilder {
  object(shape: Record<string, unknown>): unknown
  boolean(): SchemaFieldBuilder
  string(): SchemaFieldBuilder
}

/** Options installSection accepts (the seams apply() wires up). */
export interface SettingsSectionOptions {
  setSource?: (source: () => GatewaySection) => void
  onChange?: () => void
}

/** The 'settings' service surface this plugin consumes. */
export interface SettingsService {
  installSection(ctx: Context, namespace: string, schema: unknown, entry: GatewaySection, options: SettingsSectionOptions): unknown
}

/**
 * Project the patch-config gateway block onto the settings section shape (the
 * composition BASE layer the GUI edits on top of; empty strings mean default).
 * @param gateway - resolved patch gateway config.
 * @returns the settings entry.
 */
export function projectGatewayEntry(gateway: GatewayConfig | null): GatewaySection {
  if (gateway === null) {
    return { enabled: false, lifecycle: 'external', url: '', groups: '', include: '', exclude: '', tokenLabel: 'dsh', required: false }
  }
  return {
    enabled: true,
    lifecycle: gateway.embed !== null ? 'embedded' : 'external',
    url: gateway.url === DEFAULT_GATEWAY_URL ? '' : gateway.url,
    groups: gateway.groups.join(', '),
    include: gateway.include.join(', '),
    exclude: gateway.exclude.join(', '),
    tokenLabel: gateway.tokenLabel,
    required: gateway.required,
  }
}

/**
 * Rebuild the resolved gateway config from the COMPOSED settings section,
 * carrying patch-only keys (token override, autostart, timeouts) through.
 * @param section - composed section.
 * @param patchGateway - resolved patch gateway config.
 * @returns the gateway config, or null when disabled.
 */
export function gatewayConfigFrom(section: unknown, patchGateway: GatewayConfig | null): GatewayConfig | null {
  const s = section === null || typeof section !== 'object' ? {} : section as Record<string, unknown>
  if (s.enabled !== true) return null
  const raw: Record<string, unknown> = {}
  const url = typeof s.url === 'string' ? s.url.trim() : ''
  if (url.length > 0) raw.url = url
  const listOf = (value: unknown): string[] => (typeof value === 'string'
    ? value.split(',').map((item) => item.trim()).filter((item) => item.length > 0)
    : [])
  const groups = listOf(s.groups)
  if (groups.length > 0) raw.groups = groups
  const include = listOf(s.include)
  if (include.length > 0) raw.include = include
  const exclude = listOf(s.exclude)
  if (exclude.length > 0) raw.exclude = exclude
  const tokenLabel = typeof s.tokenLabel === 'string' ? s.tokenLabel.trim() : ''
  if (tokenLabel.length > 0) raw.tokenLabel = tokenLabel
  if (s.required === true) raw.required = true
  if (s.lifecycle === 'embedded') {
    raw.embed = patchGateway !== null && patchGateway.embed !== null ? patchGateway.embed : true
  }
  if (patchGateway !== null) {
    for (const key of ['token', 'tokenEnv', 'autostart', 'createToken', 'fetchTimeoutMs'] as const) {
      if (patchGateway[key] !== undefined && patchGateway[key] !== null) raw[key] = patchGateway[key]
    }
  }
  return resolveGatewayConfig(raw)
}

/**
 * Build the schemastery schema for the section (defaults mirror the
 * disabled-gateway entry so an untouched store composes to 'off').
 * @param z - schemastery builder (host-resolved).
 * @returns the section schema.
 */
export function buildGatewaySectionSchema(z: SchemaBuilder): unknown {
  return z.object({
    enabled: z.boolean().default(false),
    lifecycle: z.string().default('external'),
    url: z.string().default(''),
    groups: z.string().default(''),
    include: z.string().default(''),
    exclude: z.string().default(''),
    tokenLabel: z.string().default('dsh'),
    required: z.boolean().default(false),
  })
}
