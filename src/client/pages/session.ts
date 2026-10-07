/** The conversation tab is a READ-ONLY view of its frozen registration.
 * Latest configuration has its own opt-in tab and never substitutes for it.
 * Refresh reads metadata only: no tools are registered, tested or executed.
 */
import type { ReactLike, Kit } from '../ui.js'
import { api, isNoRoute, type Preview, type SessionView } from '../api.js'
import { LAYER_NAME_KEYS } from '../scope.js'
import type { SessionServerView, SessionToolView } from '../../shared/session-view.js'
import { registeredServers } from '../session-snapshot.js'

type T = (key: string) => string
export interface StartNextResult { ok: boolean; reason?: 'sessions-unavailable' | 'no-cwd' | 'error'; message?: string }
export type StartNext = (sessionId: string) => Promise<StartNextResult>
type Props = { t: T; sessionId: string; startNext?: StartNext; probeSessions?: () => boolean }

export function makeSessionTab(React: ReactLike, kit: Kit): (props: Props) => unknown {
  const h = kit.h
  const banner = (message: string, tone: string) => h('div', { className: 'mmc-session-notice ' + tone, role: tone === 'error' ? 'alert' : 'note' }, message)
  const chevron = () => h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, className: 'mmc-session-chevron' }, h('path', { d: 'M6 4l4 4-4 4', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }))
  return function SessionMcpTab(props: Props) {
    const { t, sessionId } = props
    const [tab, setTab] = React.useState('registered')
    const [live, setLive] = React.useState<{ id: string; view?: SessionView; error?: string; loading?: boolean }>({ id: sessionId, loading: true })
    const [next, setNext] = React.useState<{ id: string; preview?: Preview; error?: string; loading?: boolean }>({ id: sessionId })
    const [note, setNote] = React.useState('')
    const [starting, setStarting] = React.useState(false)
    const [requests] = React.useState(() => ({ id: sessionId, live: 0, next: 0, alive: true }))
    requests.id = sessionId
    const valid = (id: string, kind: 'live' | 'next', serial: number) => requests.alive && requests.id === id && requests[kind] === serial
    const refreshLive = React.useCallback(async () => {
      const serial = ++requests.live
      setLive(old => old.id === sessionId ? { ...old, loading: true, error: undefined } : { id: sessionId, loading: true })
      try {
        const view = await api.sessionView(sessionId)
        if (view.sessionId !== sessionId) throw new Error(t('sessionWrongSnapshot'))
        if (valid(sessionId, 'live', serial)) setLive({ id: sessionId, view })
      } catch (error) {
        if (valid(sessionId, 'live', serial)) setLive({ id: sessionId, error: isNoRoute(error) ? t('noRoute') : String((error as Error).message) })
      }
    }, [sessionId, t])
    const refreshNext = React.useCallback(async () => {
      const serial = ++requests.next
      setNext(old => old.id === sessionId ? { ...old, loading: true, error: undefined } : { id: sessionId, loading: true })
      try {
        const preview = await api.nextSessionPreview(sessionId)
        if (preview.forNextSession !== true) throw new Error(t('sessionNextUnsupported'))
        if (valid(sessionId, 'next', serial)) setNext({ id: sessionId, preview })
      } catch (error) {
        if (valid(sessionId, 'next', serial)) setNext({ id: sessionId, error: String((error as Error).message) })
      }
    }, [sessionId, t])
    React.useEffect(() => {
      requests.alive = true
      setTab('registered')
      setNote('')
      void refreshLive()
      return () => { requests.alive = false; requests.live++; requests.next++ }
    }, [sessionId])
    const changeTab = (value: string) => {
      setTab(value)
      setNote('')
      if (value === 'configuration' && (next.id !== sessionId || next.preview === undefined)) void refreshNext()
    }
    const view = live.id === sessionId ? live.view : undefined
    const snapshot = view?.snapshot
    const canPreviewNext = view?.capabilities?.nextSessionPreview === true && snapshot !== undefined && snapshot.restorable !== false
    const activeTab = tab === 'configuration' && canPreviewNext ? 'configuration' : 'registered'
    const groups = registeredServers(snapshot)
    const tools = groups.reduce((sum, server) => sum + server.tools.length, 0)
    const changes = view?.configurationChanges
    const changeCount = changes === undefined ? 0 : changes.added + changes.removed + changes.changed
    const preview = next.id === sessionId ? next.preview : undefined
    let counts = t('sessionSnapshotLabel')
    if (activeTab === 'configuration') {
      counts = preview !== undefined
        ? t('sessionNextCounts').replace('{count}', String(preview.entries.filter(entry => !entry.disabled).length))
        : t('loading')
    } else if (snapshot !== undefined && snapshot.restorable !== false) {
      counts = snapshot.servers !== undefined
        ? t('sessionCounts').replace('{mcps}', String(groups.length)).replace('{tools}', String(tools))
        : t('sessionFlatCounts').replace('{tools}', String(tools))
    }
    let canStart = false
    try { canStart = props.startNext !== undefined && props.probeSessions?.() === true } catch { /* host capability is optional */ }
    const copyTool = async (name: string) => {
      try { await navigator.clipboard.writeText(name); setNote(t('sessionCopied')) } catch { setNote(t('sessionCopyFailed')) }
    }
    const startNext = async () => {
      if (!canStart || props.startNext === undefined) return
      setStarting(true)
      try {
        const result = await props.startNext(sessionId)
        setNote(result.ok ? '' : result.message ?? t('startNextUnavailable'))
      } catch (error) { setNote(String((error as Error).message)) } finally { setStarting(false) }
    }
    const serviceIcon = (transport: SessionServerView['transport']) => h('svg', {
      width: 18, height: 18, viewBox: '0 0 18 18', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2,
      className: 'mmc-session-service-icon', 'aria-hidden': true,
    }, transport === 'stdio'
      ? h('path', { d: 'M3 5l3 4-3 4m6 0h6M1.5 1.5h15v15h-15z', strokeLinejoin: 'round' })
      : h('g', {}, h('circle', { cx: 9, cy: 9, r: 7 }), h('path', { d: 'M2 9h14M9 2c-4 4-4 10 0 14M9 2c4 4 4 10 0 14' })))
    const toolRow = (tool: SessionToolView) => h('div', { key: tool.publicName, className: 'mmc-session-tool' },
      h('div', { className: 'mmc-session-tool-text' },
        h('code', { title: tool.publicName }, tool.name),
        tool.description ? h('p', {}, tool.description) : null),
      h('button', { type: 'button', className: 'mmc-session-copy', title: t('sessionCopyTool'),
        'aria-label': t('sessionCopyTool') + ': ' + tool.name, onClick: () => void copyTool(tool.publicName) },
        h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
          h('rect', { x: 5, y: 5, width: 8, height: 8, rx: 1.5, stroke: 'currentColor' }),
          h('path', { d: 'M3 10H2V2h8v1', stroke: 'currentColor', strokeLinejoin: 'round' }))))
    const serviceRow = (server: SessionServerView) => h('details', { key: server.name, className: 'mmc-session-service' },
      h('summary', { className: 'mmc-session-summary' },
        serviceIcon(server.transport),
        h('span', { className: 'mmc-session-name' }, server.name),
        h('span', { className: 'mmc-session-transport' }, server.transport === 'http' ? 'HTTP' : server.transport === 'stdio' ? 'stdio' : 'MCP'),
        h('span', { className: 'mmc-session-tool-count' }, t('sessionToolCount').replace('{count}', String(server.tools.length))),
        chevron()),
      h('div', { className: 'mmc-session-tools' }, ...server.tools.map(toolRow)))
    let registeredContent: unknown
    if (live.id !== sessionId || (live.loading && snapshot === undefined)) registeredContent = kit.empty(t('loading'))
    else if (live.error) registeredContent = banner(live.error, 'error')
    else if (view?.snapshotProblem !== undefined) registeredContent = banner(t('sessionSnapshotUnreadable'), 'warn')
    else if (snapshot === undefined) registeredContent = kit.empty(t('sessionSnapshotMissing'))
    else if (snapshot.restorable === false) registeredContent = banner(t('sessionSnapshotLegacy'), 'warn')
    else if (groups.length === 0) registeredContent = kit.empty(t('sessionNoRegistered'))
    else registeredContent = h('div', { className: 'mmc-session-services' }, ...groups.map(serviceRow))
    const registered = h('section', { className: 'mmc-session-registered', 'aria-label': t('sessionRegisteredTab') },
      registeredContent, kit.footnote(t('sessionFrozenHint')))
    let configContent: unknown
    if (next.id !== sessionId || next.loading) configContent = kit.empty(t('loading'))
    else if (next.error) configContent = banner(next.error, 'error')
    else if (preview === undefined) configContent = kit.empty(t('loading'))
    else if (preview.entries.length === 0) configContent = kit.empty(t('empty'))
    else configContent = h('div', { className: 'mmc-session-services' }, ...preview.entries.map(entry => h('div', {
      key: entry.name, className: 'mmc-session-config-row',
    }, h('span', { className: 'mmc-session-name' }, entry.name),
    h('span', { className: 'mmc-session-config-source' }, t(LAYER_NAME_KEYS[entry.layerId ?? ''] ?? entry.level)),
    h('span', { className: 'mmc-session-transport' }, entry.disabled ? t('disabled') : typeof entry.def.url === 'string' ? 'HTTP' : typeof entry.def.command === 'string' ? 'stdio' : 'MCP'))))
    const configuration = h('section', { className: 'mmc-session-configuration', 'aria-label': t('sessionConfigTab') },
      banner(t('sessionNextHint'), 'info'), configContent, kit.footnote(t('sessionManageHint')),
      canStart ? kit.btn(starting ? t('loading') : t('startNext'), () => void startNext(), { primary: true, disabled: starting }) : null)
    return h('div', { className: 'mmc-root mmc-session', 'data-mmc-session': sessionId },
      h('header', { className: 'mmc-session-head' }, h('div', {}, h('h3', {}, t(activeTab === 'configuration' ? 'sessionConfigTab' : 'sessionTitle')), h('span', { className: 'mmc-sub' }, counts)), kit.btn(t('refresh'), () => { void refreshLive(); if (activeTab === 'configuration') void refreshNext() }, { disabled: !!live.loading || (activeTab === 'configuration' && !!next.loading) })),
      h('div', { className: 'mmc-session-navigation' }, kit.tabs([{ key: 'registered', label: t('sessionRegisteredTab') }, ...(canPreviewNext ? [{ key: 'configuration', label: t('sessionConfigTab') }] : [])], activeTab, changeTab), canPreviewNext && changeCount > 0 ? h('button', { type: 'button', className: 'mmc-session-change', onClick: () => changeTab('configuration') }, t('sessionChanged')) : null),
      note ? h('div', { role: 'status', className: 'mmc-sub' }, note) : null,
      activeTab === 'registered' ? registered : configuration,
      h('details', { className: 'mmc-session-info' }, h('summary', {}, t('sessionInfo')), h('div', {}, h('span', {}, t('sessionIdLabel')), h('code', {}, sessionId), snapshot ? h('span', {}, t('sessionRegisteredAt')) : null, snapshot ? h('time', { dateTime: snapshot.registeredAt }, snapshot.registeredAt) : null)))
  }
}
