/**
 * The Traffic view: who (token + self-reported client) asked what, across
 * every engine MCP — paged interaction rows, one expandable full entry, and
 * a clear action (per-client or whole log) behind an explicit confirm.
 * Typed against the bridge contract; unwired routes say so explicitly.
 */
import type { ReactLike, Kit } from '../ui.js'
import { api, isNoRoute, type TrafficPage } from '../api.js'

type T = (key: string) => string

/** HH:MM:SS out of an ISO timestamp; see the same helper in pages/mcp.ts. */
function shortTime(iso: string | undefined): string {
  if (typeof iso !== 'string' || iso === '') return ''
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(iso)
  return m === null ? iso : m[2]!
}

export function makeTrafficPage(React: ReactLike, kit: Kit): (props: { t: T }) => unknown {
  return function TrafficPagePane(props: { t: T }) {
    const t = props.t
    const [filter, setFilter] = React.useState({ mcp: '', client: '', method: '', actionsOnly: false })
    const [page, setPage] = React.useState(0)
    const [data, setData] = React.useState<TrafficPage | undefined>(undefined)
    const [err, setErr] = React.useState('')
    const [full, setFull] = React.useState('')
    const load = React.useCallback(async () => {
      setErr(''); setData(undefined)
      try {
        setData(await api.traffic({
          ...(filter.mcp !== '' ? { mcp: filter.mcp } : {}),
          ...(filter.client !== '' ? { client: filter.client } : {}),
          ...(filter.method !== '' ? { method: filter.method } : {}),
          actionsOnly: filter.actionsOnly,
          page,
        }))
      } catch (error) { setErr((error as { message?: string }).message ?? String(error)) }
    }, [filter, page])
    React.useEffect(() => { void load() }, [load])
    const expand = async (seq: number) => {
      setFull('')
      try { setFull(JSON.stringify(await api.trafficEntry(seq), null, 2)) } catch (error) { setFull((error as { message?: string }).message ?? String(error)) }
    }
    const clear = async () => {
      const msg = filter.client !== '' ? t('confirmClearClient').replace('{c}', filter.client) : t('confirmClearAll')
      if (!confirm(msg)) return
      try { await api.trafficClear(filter.client !== '' ? filter.client : undefined); await load() }
      catch (error) { setErr((error as { message?: string }).message ?? String(error)) }
    }
    return kit.h('div', { className: 'mmc-root' },
      kit.head(t('trafficIntro'),
        kit.btn(t('refresh'), () => { void load() }, { key: 'refresh' }),
        kit.btn(t('clear'), () => { void clear() }, { key: 'clear', danger: true }),
      ),
      kit.h('div', { className: 'mmc-row' },
        kit.input({ placeholder: 'mcp', value: filter.mcp, onChange: (e: { target: { value: string } }) => { setFilter({ ...filter, mcp: e.target.value }); setPage(0) }, spellCheck: false }),
        kit.input({ placeholder: 'client', value: filter.client, onChange: (e: { target: { value: string } }) => { setFilter({ ...filter, client: e.target.value }); setPage(0) }, spellCheck: false }),
        kit.input({ placeholder: 'method', value: filter.method, onChange: (e: { target: { value: string } }) => { setFilter({ ...filter, method: e.target.value }); setPage(0) }, spellCheck: false }),
        kit.btn(filter.actionsOnly ? t('actionsOnlyOn') : t('actionsOnlyOff'), () => { setFilter({ ...filter, actionsOnly: !filter.actionsOnly }); setPage(0) }),
      ),
      err !== '' ? kit.error(isNoRoute({ message: err }) ? t('bridgePending') : t('loadFailed') + ': ' + err) : null,
      data === undefined && err === '' ? kit.note('…') : null,
      // A caller is an OBJECT here (key + display label + counts), not a
      // string. Rendering it as one printed a row of `[object Object]`
      // buttons that filtered on nothing.
      data !== undefined && data.clients.length > 0
        ? kit.h('div', { className: 'mmc-row' }, data.clients.map((c) =>
          kit.btn(
            c.label + (c.count !== undefined ? ' · ' + String(c.count) : ''),
            () => { setFilter({ ...filter, client: c.key }); setPage(0) },
            { disabled: c.key === filter.client, key: c.key },
          )))
        : null,
      data !== undefined && data.rows.length === 0 ? kit.empty(t('noTraffic')) : null,
      data !== undefined && data.rows.length > 0
        ? kit.h('div', { className: 'mmc-section' },
          kit.rows(...data.rows.map((r) => kit.row({
            key: String(r.seq),
            state: r.ok === false ? 'bad' : 'ok',
            name: r.mcp,
            // ONE chip — the method is what classifies the row. The rest was
            // four more bordered chips and two grey runs on a 560px line,
            // which wrapped into a paragraph per call.
            badge: { text: r.method },
            // Engine field names: `at`, `params`. There is no HTTP status on a
            // JSON-RPC call — `ok` already carries the outcome, and the row's
            // state dot shows it.
            meta: kit.factsOf(
              shortTime(r.at),
              r.clientName ?? r.client ?? '',
              r.ms !== undefined ? String(r.ms) + 'ms' : '',
              (r.params ?? '').replace(/\s+/g, ' ').slice(0, 70),
            ),
            onOpen: () => { void expand(r.seq) },
          }))),
          kit.h('div', { className: 'mmc-row' },
            kit.btn('\u2039', () => { setPage(Math.max(0, page - 1)) }, { disabled: page === 0 }),
            kit.tag(t('pageN').replace('{n}', String(page + 1)) + ' · ' + String(data.total)),
            kit.btn('\u203a', () => { setPage(page + 1) }, { disabled: data.more !== true }),
          ),
        )
        : null,
      full !== '' ? kit.mono(full) : null,
    )
  }
}
