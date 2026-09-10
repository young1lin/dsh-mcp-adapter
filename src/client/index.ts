/**
 * The browser half (bundled by esbuild into dist/client.js): one
 * __ModuleLoader__ factory registering
 *  - a「MCP 与连接」settings section (id mcp-connections — NOT Requests),
 *    with the workbench + data + traffic + tunnels + advanced sub-views as
 *    tabs (each a STABLE component identity — conditional direct calls of
 *    hook-using pages broke hook order),
 *  - a conversation「MCP」tab bound to the REAL sessionId prop, showing
 *    snapshot vs current vs pending session overrides.
 * Host data flows only through the same-origin /dsh-mcp-manager bridge.
 */
import { NS, en, zh } from './i18n.js'
import { css, kit, type ReactLike } from './ui.js'
import { paintNavIcon } from './nav-icon.js'
import { makeMcpWorkbench } from './pages/mcp.js'
import { makeDataPage } from './pages/data.js'
import { makeTrafficPage } from './pages/traffic.js'
import { makeTunnelsPage } from './pages/tunnels.js'
import { makeAdvancedPage } from './pages/advanced.js'
import { makeSessionTab, type StartNext } from './pages/session.js'

// window.__ModuleLoader__ is declared in src/globals.d.ts (repo-wide).

/**
 * The bundle's registration id — INJECTED at build time from package.json's
 * name by scripts/build-client.mjs. The dsh client-modules contract keys the
 * registration on the package name the loader discovered for the row
 * ("Plugin id (package name) — the registration key; must match the graph
 * row being executed", packages/client/modules/src/client/manifest.ts), so a
 * hardcoded literal here breaks the browser half on every package rename.
 * The same id also owns the injected <style> tags (claimStyles/HMR CSS
 * attribution checks data-plugin-css against it).
 */
declare const CLIENT_MODULE_ID: string

type T = (key: string) => string

interface ClientCtx {
  locale: { register(ns: string, dicts: Record<string, Record<string, string>>): unknown; bind(ns: string): (key: string) => string }
  slots: { inject(slot: string, register: () => unknown): unknown; register(...args: unknown[]): unknown }
  effect(register: () => unknown, label?: string): unknown
  /**
   * Cordis service access. Used ONLY at click time (lazily) for the verified
   * 'sessions' host action — never at apply time, so a host build without a
   * service cannot wedge this plugin's activation.
   */
  get?: (name: string) => unknown
}

/** The verified subset of the host client 'sessions' service (dsh-client-runtime SessionRuntime). */
interface SessionsFace {
  create(opts: { cwd?: string; workspaceId?: string }): Promise<string>
  open(sessionId: string): void
  list: { getSnapshot(): { byId: Record<string, { cwd?: string } | undefined> } }
}

function sessionsFace(ctx: ClientCtx): SessionsFace | undefined {
  try {
    const get = ctx.get
    if (typeof get !== 'function') return undefined
    const s = get('sessions')
    if (s === null || typeof s !== 'object') return undefined
    const face = s as Partial<SessionsFace>
    if (typeof face.create !== 'function' || typeof face.open !== 'function' || face.list === undefined || typeof face.list.getSnapshot !== 'function') {
      return undefined
    }
    return face as SessionsFace
  } catch {
    return undefined
  }
}

/**
 * Start-next-session through VERIFIED host actions only:
 * sessions.create({cwd}) -> id, sessions.open(id). When the host does not
 * expose the sessions service (or the current session has no cwd), the
 * session tab disables the action and explains — no unsupported navigation
 * is attempted.
 */
function makeStartNext(ctx: ClientCtx): StartNext {
  return async (sessionId) => {
    const s = sessionsFace(ctx)
    if (s === undefined) return { ok: false, reason: 'sessions-unavailable' }
    let cwd: string | undefined
    try { cwd = s.list.getSnapshot().byId[sessionId]?.cwd } catch { cwd = undefined }
    if (typeof cwd !== 'string' || cwd.length === 0) return { ok: false, reason: 'no-cwd' }
    try {
      const id = await s.create({ cwd })
      s.open(id)
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: 'error', message: error instanceof Error ? error.message : String(error) }
    }
  }
}

window.__ModuleLoader__!.load({
  id: CLIENT_MODULE_ID,
  factory: (require: (id: string) => unknown) => {
    if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${CLIENT_MODULE_ID}"]`) === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = CLIENT_MODULE_ID
      tag.dataset.pluginCss = CLIENT_MODULE_ID
      tag.textContent = css
      document.head.appendChild(tag)
    }
    const React = require('react') as ReactLike
    const k = kit(React)

    // One STABLE component identity per page — created ONCE per React/kit
    // binding. Rendering these through createElement (never calling the page
    // functions directly as conditional children) is what keeps every page's
    // hooks in their own component instance.
    const McpPane = makeMcpWorkbench(React, k)
    const DataPane = makeDataPage(React, k)
    const TrafficPane = makeTrafficPage(React, k)
    const TunnelsPane = makeTunnelsPage(React, k)
    const AdvancedPane = makeAdvancedPage(React, k)
    const SessionTab = makeSessionTab(React, k)

    /** The settings body: tabbed workbench (MCP / data / traffic / SSH / advanced). */
    function Workbench(props: { t?: T }) {
      const t = props.t ?? ((key: string) => key)
      const [tab, setTab] = React.useState<'mcp' | 'data' | 'traffic' | 'tunnels' | 'advanced'>('mcp')
      return k.h('div', { className: 'mmc-root', style: { padding: '16px', overflow: 'auto', height: '100%' } },
        k.tabs([
          { key: 'mcp', label: t('entries') },
          { key: 'data', label: t('dataTitle') },
          { key: 'traffic', label: t('trafficTitle') },
          { key: 'tunnels', label: t('tunnels') },
          { key: 'advanced', label: t('advanced') },
        ], tab, (x) => setTab(x as typeof tab)),
        tab === 'mcp' ? k.h(McpPane, { t }) :
        tab === 'data' ? k.h(DataPane, { t }) :
        tab === 'traffic' ? k.h(TrafficPane, { t }) :
        tab === 'tunnels' ? k.h(TunnelsPane, { t }) :
        k.h(AdvancedPane, { t }),
      )
    }

    const module = { exports: {} as Record<string, unknown> }
    module.exports.inject = ['slots', 'locale', 'settingsScope']
    module.exports.apply = (ctx: ClientCtx) => {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'mcp-connections: dictionaries')
      const t = ctx.locale.bind(NS)
      // The nav row's icon is not part of the section contract — the shell
      // picks it from a hard-coded id list and gives everyone else its gear.
      // See nav-icon.ts for why replacing the drawn glyph is the only seat.
      ctx.effect(() => paintNavIcon(() => t('nav')), 'mcp-connections: nav icon')
      // Settings → MCP 与连接 (new id; the old 'requests' id is retired)
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'mcp-connections',
        order: 15,
        label: () => t('nav'),
        locale: NS,
        inject: () => ({ t }),
      }, Workbench))
      // NOTE: the old 'workspace.menu.action' registration is intentionally
      // GONE: no shipped host build declares that slot (verified against the
      // installed @deepseek-ai host packages), and no client service can open
      // the settings modal programmatically (its open state is shell-local in
      // ui-settings-general). Registering it was an inert promise of a menu
      // entry that cannot work; restore it only when a host build actually
      // declares the slot — see docs/workspace-menu-extension.md.
      // Conversation「MCP」tab: the framework hands slot components the
      // session id as a standard prop (dsh-request-log's contract).
      const startNext = makeStartNext(ctx)
      const probeSessions = (): boolean => sessionsFace(ctx) !== undefined
      ctx.slots.inject('conversation.view', () => ctx.slots.register(
        { name: 'conversation.view', id: 'mcp-session', order: 31, locale: NS, label: () => t('tabLabel') },
        (props: { sessionId?: string }) => k.h('div', { style: { padding: '16px', overflow: 'auto', height: '100%' } },
          k.h(SessionTab, { t, sessionId: String(props.sessionId ?? ''), startNext, probeSessions })),
      ))
    }
    return module.exports
  },
})
