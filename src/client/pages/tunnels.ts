/**
 * SSH connections + port mappings page: list, add, test, trust, start/stop.
 * Factory form (stable component identity); the two add-forms are separate
 * component identities so their conditional rendering cannot break hook
 * order.
 */
import type { ReactLike, Kit } from '../ui.js'
import { view } from '../ui.js'
import { api } from '../api.js'

type T = (key: string) => string

interface Conn { id: string; name: string; host: string; port: number; username: string; authType: string; state: string; reason?: string; hostKey?: string; ruleCount: number; activeRules: number }
interface Rule { id: string; name: string; connectionId: string; localPort: number; targetHost: string; targetPort: number; state: string; reason?: string; connectionName: string; sockets: number; bytesIn: number; bytesOut: number; portOwner?: { pid: number; name: string }; mcpRows: Array<{ name: string; state: string; known: boolean }> }
interface Data { connections: Conn[]; rules: Rule[] }

export function makeTunnelsPage(React: ReactLike, kit: Kit): (props: { t: T }) => unknown {
  const ConnFormView = view<{ t: T; onSubmit: (input: Record<string, unknown>) => Promise<void> }>(
    React, (props) => ConnForm(React, kit, props.t, props.onSubmit))
  const RuleFormView = view<{ t: T; conns: Conn[]; onSubmit: (input: Record<string, unknown>) => Promise<void> }>(
    React, (props) => RuleForm(React, kit, props.t, props.conns, props.onSubmit))

  return function TunnelsPage(props: { t: T }) {
    const t = props.t
    const [data, setData] = React.useState<Data | undefined>(undefined)
    const [err, setErr] = React.useState('')
    const [note, setNote] = React.useState('')
    const [adding, setAdding] = React.useState<'none' | 'conn' | 'rule'>('none')
    const refresh = React.useCallback(async () => {
      setErr('')
      try { setData(await api.tunnels() as unknown as Data) }
      catch (error) { setErr((error as { message?: string }).message ?? String(error)) }
    }, [])
    React.useEffect(() => { void refresh() }, [refresh])
    const act = async (label: string, op: string, params: Record<string, unknown>) => {
      setNote(label + ' …')
      try {
        const out = await api.tunnelOp(op, params)
        setNote(label + ': ' + JSON.stringify(out).slice(0, 160))
        await refresh()
      } catch (error) { setNote(label + ': ' + ((error as { message?: string }).message ?? String(error))) }
    }
    if (data === undefined) return err !== '' ? kit.card(kit.error(t('loadFailed') + ': ' + err), kit.btn(t('retry'), () => { void refresh() })) : kit.note('…')
    return kit.h('div', { className: 'mmc-root' },
      // The two "add" buttons moved DOWN into the section that owns each
      // thing: a header button acts on whatever it sits above, and up here
      // "Add rule" sat above the connections it cannot be attached to.
      kit.head(t('tunnelsIntro'), kit.btn(t('refresh'), () => { void refresh() }, { key: 'refresh' })),
      err !== '' ? kit.error(err) : null,
      note !== '' ? kit.note(note) : null,
      adding === 'conn'
        ? kit.h(ConnFormView, {
            key: 'conn-form', t,
            onSubmit: async (input: Record<string, unknown>) => { await act('add', 'upsertConnection', { input }); setAdding('none') },
          })
        : null,
      adding === 'rule'
        ? kit.h(RuleFormView, {
            key: 'rule-form', t, conns: data.connections,
            onSubmit: async (input: Record<string, unknown>) => { await act('add', 'upsertRule', { input }); setAdding('none') },
          })
        : null,
      kit.section(t('connections'), {
        sub: t('connectionsIntro'),
        actions: [kit.btn(t('addConnection'), () => setAdding(adding === 'conn' ? 'none' : 'conn'), { key: 'conn', primary: true })],
      },
        data.connections.length === 0
          ? kit.empty(t('noConnections'))
          : kit.rows(...data.connections.map((c) => kit.row({
              key: c.id,
              state: c.state === 'connected' ? 'ok' : c.state === 'error' ? 'bad' : 'off',
              name: c.name,
              badge: { text: c.authType },
              meta: kit.factsOf(
                c.username + '@' + c.host + ':' + String(c.port), c.state,
                c.reason !== undefined && c.reason !== '' ? c.reason.slice(0, 80) : '',
              ),
              menuLabel: t('moreFor').replace('{n}', c.name),
              menu: [
                { label: t('test'), onPick: () => { void act('test', 'testConnection', { id: c.id }) } },
                // Trusting a host key is only meaningful while there is none.
                ...(c.hostKey === undefined || c.hostKey === null
                  ? [{ label: t('trust'), onPick: () => { void act('trust', 'trustHostKey', { id: c.id }) } }]
                  : []),
                { label: t('delete'), danger: true, onPick: () => { if (confirm(c.name + ' ?')) void act('del', 'deleteConnection', { id: c.id }) } },
              ],
            }))),
      ),
      kit.section(t('rules'), {
        sub: t('rulesIntro'),
        // A rule forwards a port ON a connection, so with no connections the
        // action is a dead end: disabled says that before the click, and the
        // empty state below says why.
        actions: [kit.btn(t('addRule'), () => setAdding(adding === 'rule' ? 'none' : 'rule'), { key: 'rule', disabled: data.connections.length === 0 })],
      },
        data.rules.length === 0
          ? kit.empty(data.connections.length === 0 ? t('noRulesNoConn') : t('noRules'))
          : kit.rows(...data.rules.map((r) => {
              const up = r.state === 'up' || r.state === 'reconnecting'
              return kit.row({
                key: r.id,
                state: r.state === 'up' ? 'ok' : r.state === 'error' ? 'bad' : 'off',
                name: r.name,
                badge: { text: r.connectionName },
                meta: kit.factsOf(
                  '127.0.0.1:' + String(r.localPort) + ' → ' + r.targetHost + ':' + String(r.targetPort),
                  r.state, String(r.sockets) + ' sock', String(Math.round(r.bytesIn / 1024)) + ' KiB',
                  r.portOwner !== undefined ? 'pid ' + String(r.portOwner.pid) + ' (' + r.portOwner.name + ')' : '',
                  r.reason !== undefined && r.reason !== '' ? r.reason.slice(0, 80) : '',
                ),
                // Start/stop IS the row's state, so it is a switch. The pair
                // of Start/Stop buttons named the action and left the reader
                // to infer the state from whichever label was showing.
                toggle: { on: up, label: r.name, onChange: (next) => { void act(next ? 'start' : 'stop', next ? 'startRule' : 'stopRule', { id: r.id }) } },
                menuLabel: t('moreFor').replace('{n}', r.name),
                menu: [
                  { label: t('delete'), danger: true, onPick: () => { if (confirm(r.name + ' ?')) void act('del', 'deleteRule', { id: r.id, force: true }) } },
                ],
              })
            })),
      ),
    )
  }
}

function ConnForm(React: ReactLike, kit: Kit, t: T, onSubmit: (input: Record<string, unknown>) => Promise<void>) {
  const [form, setForm] = React.useState({ name: '', host: '', port: '22', username: '', authType: 'password', password: '', keyPath: '' })
  const set = (k: string, v: string) => setForm({ ...form, [k]: v })
  return kit.card(
    kit.h('div', { className: 'mmc-grid' },
      field(kit, t, 'name', kit.input({ value: form.name, onChange: (e: { target: { value: string } }) => set('name', e.target.value) })),
      field(kit, t, 'host', kit.input({ value: form.host, onChange: (e: { target: { value: string } }) => set('host', e.target.value) })),
      field(kit, t, 'port', kit.input({ value: form.port, onChange: (e: { target: { value: string } }) => set('port', e.target.value) })),
      field(kit, t, 'username', kit.input({ value: form.username, onChange: (e: { target: { value: string } }) => set('username', e.target.value) })),
      field(kit, t, 'authType', kit.select({ value: form.authType, onChange: (e: { target: { value: string } }) => set('authType', e.target.value) },
        kit.h('option', { value: 'password' }, 'password'), kit.h('option', { value: 'key' }, 'key'))),
      form.authType === 'password'
        ? field(kit, t, 'password', kit.input({ type: 'password', value: form.password, onChange: (e: { target: { value: string } }) => set('password', e.target.value) }))
        : field(kit, t, 'keyPath', kit.input({ value: form.keyPath, onChange: (e: { target: { value: string } }) => set('keyPath', e.target.value) })),
    ),
    kit.btn(t('save'), () => { void onSubmit({ ...form, port: Number(form.port) }) }, { primary: true, disabled: form.name === '' || form.host === '' }),
  )
}

function RuleForm(React: ReactLike, kit: Kit, t: T, conns: Conn[], onSubmit: (input: Record<string, unknown>) => Promise<void>) {
  const [form, setForm] = React.useState({ name: '', connectionId: conns[0]?.id ?? '', localPort: '', targetHost: '127.0.0.1', targetPort: '' })
  const set = (k: string, v: string) => setForm({ ...form, [k]: v })
  return kit.card(
    kit.h('div', { className: 'mmc-grid' },
      field(kit, t, 'name', kit.input({ value: form.name, onChange: (e: { target: { value: string } }) => set('name', e.target.value) })),
      field(kit, t, 'connection', kit.select({ value: form.connectionId, onChange: (e: { target: { value: string } }) => set('connectionId', e.target.value) },
        conns.map((c) => kit.h('option', { key: c.id, value: c.id }, c.name)))),
      field(kit, t, 'port', kit.input({ value: form.localPort, onChange: (e: { target: { value: string } }) => set('localPort', e.target.value) })),
      field(kit, t, 'target', kit.input({ value: form.targetHost + ':' + form.targetPort, onChange: (e: { target: { value: string } }) => { const [h, p] = e.target.value.split(':'); setForm({ ...form, targetHost: h ?? '', targetPort: p ?? '' }) } })),
    ),
    kit.btn(t('save'), () => { void onSubmit({ ...form, localPort: Number(form.localPort), targetPort: Number(form.targetPort) }) }, { primary: true, disabled: form.name === '' || form.localPort === '' || form.connectionId === '' }),
  )
}

function field(kit: Kit, t: T, labelKey: string, control: unknown) {
  const label = t(labelKey)
  return kit.h('label', { style: { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px' } },
    kit.h('span', { className: 'mmc-note' }, label), control)
}
