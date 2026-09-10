/**
 * Advanced page: named-token CRUD (create / reveal / rotate / revoke — each an
 * EXPLICIT action), the MCP endpoint's one switch + one port, and engine
 * diagnostics.
 *
 * Destructive or credential-affecting actions always confirm first.
 *
 * Layout: each concern is a SECTION — a label, one line of what it is, and its
 * own actions — not a bordered card. Six stacked boxes, each cramming a title,
 * a sentence and two buttons onto one 560px line, is what made this page read
 * as a wall of settings with no shape.
 */
import type { ReactLike, Kit } from '../ui.js'
import { view } from '../ui.js'
import { api, isNoRoute, type ListenerState, type TokenRow, type TokenSecret } from '../api.js'

type T = (key: string) => string

/** An ISO timestamp in a list is noise; the day is the part anyone reads. */
function shortDate(iso: string | undefined): string {
  if (iso === undefined || iso === '') return ''
  return iso.length >= 10 ? iso.slice(0, 10) : iso
}

export function makeAdvancedPage(React: ReactLike, kit: Kit): (props: { t: T }) => unknown {
  // Stable identity for the conditionally-rendered hook-using form.
  const TokenCreateView = view<{ t: T; onDone: () => void }>((React), (props) => TokenCreateForm(React, kit, props.t, props.onDone))

  return function AdvancedPage(props: { t: T }) {
    const t = props.t
    // tokens
    const [tokens, setTokens] = React.useState<TokenRow[] | undefined>(undefined)
    const [tokenErr, setTokenErr] = React.useState('')
    const [shown, setShown] = React.useState<TokenSecret | undefined>(undefined)
    const [creatingToken, setCreatingToken] = React.useState(false)
    // diagnostics keeps its own output line.
    const [memory, setMemory] = React.useState<Record<string, unknown> | undefined>(undefined)
    const [memNote, setMemNote] = React.useState('')
    // The MCP endpoint. `draftPort` is held separately from the loaded state so
    // typing a port does not fight the value that came back from the server.
    const [listener, setListener] = React.useState<ListenerState | undefined>(undefined)
    const [draftPort, setDraftPort] = React.useState('')
    const [endpointNote, setEndpointNote] = React.useState('')

    const measure = React.useCallback(async (tree: boolean) => {
      setMemNote('…')
      try { setMemory(await api.memory(tree)); setMemNote('') }
      catch (error) { setMemNote((error as { message?: string }).message ?? String(error)) }
    }, [])
    const loadTokens = React.useCallback(async () => {
      setTokenErr(''); setTokens(undefined)
      try { setTokens((await api.tokens()).tokens) } catch (error) { setTokenErr((error as { message?: string }).message ?? String(error)) }
    }, [])
    const loadEndpoint = React.useCallback(async () => {
      setEndpointNote('')
      try {
        const state = await api.listener()
        setListener(state)
        setDraftPort(state.port > 0 ? String(state.port) : '')
      } catch (error) { setEndpointNote((error as { message?: string }).message ?? String(error)) }
    }, [])
    React.useEffect(() => { void loadTokens(); void loadEndpoint() }, [loadTokens, loadEndpoint])
    /** Save the switch and the port together — they are one decision. */
    const saveEndpoint = async (enabled: boolean) => {
      setEndpointNote('…')
      try {
        const port = draftPort.trim() === '' ? 0 : Number(draftPort.trim())
        const saved = await api.listenerSave(enabled, Number.isFinite(port) ? port : -1)
        setListener(saved)
        setDraftPort(saved.port > 0 ? String(saved.port) : '')
        // A port someone else holds is worth hearing at the click, not after
        // the restart that was supposed to make it work.
        setEndpointNote(saved.problem === undefined ? t('endpointRestart') : saved.problem + ' · ' + t('endpointRestart'))
      } catch (error) { setEndpointNote((error as { message?: string }).message ?? String(error)) }
    }

    const reveal = async (id: string) => {
      setShown(undefined)
      try { setShown(await api.tokenSecret(id)) } catch (error) { setTokenErr((error as { message?: string }).message ?? String(error)) }
    }
    const rotate = async (row: TokenRow) => {
      if (!confirm(t('confirmRotate').replace('{t}', row.label !== '' ? row.label : row.id))) return
      try { setShown(await api.tokenRotate(row.id)); await loadTokens() } catch (error) { setTokenErr((error as { message?: string }).message ?? String(error)) }
    }
    const revoke = async (row: TokenRow) => {
      if (!confirm(t('confirmRevoke').replace('{t}', row.label !== '' ? row.label : row.id))) return
      try { await api.tokenRevoke(row.id); setShown(undefined); await loadTokens() } catch (error) { setTokenErr((error as { message?: string }).message ?? String(error)) }
    }

    const tokenRow = (row: TokenRow) => {
      const name = row.label !== '' ? row.label : row.id
      return kit.row({
        key: row.id,
        state: 'ok',
        name,
        meta: kit.factsOf(
          name === row.id ? '' : row.id,
          shortDate(row.createdAt) !== '' ? t('tokenCreated') + ' ' + shortDate(row.createdAt) : '',
          row.lastUsedAt !== undefined ? t('tokenUsed') + ' ' + shortDate(row.lastUsedAt) : t('tokenNeverUsed'),
        ),
        menuLabel: t('moreFor').replace('{n}', name),
        menu: [
          { label: t('tokenReveal'), onPick: () => { void reveal(row.id) } },
          { label: t('tokenRotate'), onPick: () => { void rotate(row) } },
          { label: t('tokenRevoke'), danger: true, onPick: () => { void revoke(row) } },
        ],
      })
    }

    return kit.h('div', { className: 'mmc-root' },
      kit.head(t('advancedIntro')),

      // --- named tokens: CRUD + rotate/revoke (explicit) ---
      kit.section(t('tokensTitle'), {
        sub: t('tokensIntro'),
        actions: [
          kit.btn(t('refresh'), () => { void loadTokens() }, { key: 'refresh' }),
          kit.btn(t('tokenNew'), () => { setCreatingToken(!creatingToken) }, { key: 'new', primary: true }),
        ],
      },
        tokenErr !== '' ? kit.error(isNoRoute({ message: tokenErr }) ? t('bridgePending') : tokenErr) : null,
        tokens === undefined && tokenErr === '' ? kit.note('…') : null,
        creatingToken ? kit.h(TokenCreateView, { key: 'token-new', t, onDone: () => { setCreatingToken(false); void loadTokens() } }) : null,
        shown !== undefined
          ? kit.card(
              kit.h('div', { className: 'mmc-row' },
                kit.h('span', { className: 'mmc-note' }, t('tokenSecretShown').replace('{t}', shown.label !== '' ? shown.label : shown.id)),
                kit.actions(kit.btn('×', () => setShown(undefined), { key: 'hide', title: t('close') })),
              ),
              kit.mono(shown.secret),
            )
          : null,
        tokens !== undefined && tokens.length === 0 ? kit.empty(t('noTokens')) : null,
        tokens !== undefined && tokens.length > 0 ? kit.rows(...tokens.map(tokenRow)) : null,
      ),

      // --- the MCP endpoint: one switch, one port ---
      kit.section(t('endpointTitle'), { sub: t('endpointIntro') },
        kit.rows(kit.row({
          key: 'publish',
          name: t('endpointOn'),
          meta: listener === undefined ? ''
            : listener.enabled ? t('endpointAt').replace('{n}', String(listener.port)) : t('endpointOff'),
          // A config file outranks the switch; showing it live but inert is
          // more honest than hiding where the value comes from.
          toggle: listener === undefined || listener.locked ? undefined : {
            on: listener.enabled, label: t('endpointOn'),
            onChange: () => { void saveEndpoint(!listener.enabled) },
          },
        }), kit.row({
          key: 'port',
          name: t('endpointPort'),
          extra: kit.input({
            placeholder: '19999',
            value: draftPort,
            disabled: listener === undefined || listener.locked,
            onChange: (v: string) => { setDraftPort(v) },
            style: { width: '110px' },
          }),
          action: listener === undefined || listener.locked ? undefined
            : { label: t('endpointSave'), onPick: () => { void saveEndpoint(listener.enabled) } },
        })),
        listener?.locked === true ? kit.note(t('endpointLocked')) : null,
        // The switch shows the INTENT; this is what the engine is living with.
        // They differ exactly when the port was taken, which is the case worth
        // shouting about — the endpoint is off and nothing else says so.
        listener?.problem !== undefined ? kit.error(listener.problem) : null,
        endpointNote !== '' ? kit.note(endpointNote) : null,
      ),

      // --- diagnostics (a debug tool, so it sits last) ---
      kit.section(t('diagnosticsTitle'), { sub: t('diagnosticsIntro') },
        kit.rows(kit.row({
          key: 'memory',
          name: t('rowMemory'),
          meta: memory !== undefined ? String(memory.gatewayMb) + ' MB' : '',
          action: { label: t('refreshMemory'), onPick: () => { void measure(true) } },
        })),
        memNote !== '' ? kit.note(memNote) : null,
        memory !== undefined
          ? kit.h('div', { className: 'mmc-grid' },
              kit.kv('RSS', String(memory.gatewayMb) + ' MB'),
              kit.kv(t('memChildren'), String(memory.childrenMb ?? 0) + ' MB / ' + String(memory.processCount ?? 1)),
            )
          : null,
      ),
    )
  }

  function TokenCreateForm(React: ReactLike, kit: Kit, t: T, onDone: () => void) {
    const [label, setLabel] = React.useState('')
    const [busy, setBusy] = React.useState(false)
    const [err, setErr] = React.useState('')
    const [secret, setSecret] = React.useState<TokenSecret | undefined>(undefined)
    const go = async () => {
      setBusy(true); setErr('')
      try { setSecret(await api.tokenCreate(label.trim())) } catch (error) { setErr((error as { message?: string }).message ?? String(error)) }
      finally { setBusy(false) }
    }
    return kit.card(
      kit.h('div', { className: 'mmc-row' },
        kit.input({ placeholder: t('tokenLabel'), value: label, onChange: (e: { target: { value: string } }) => setLabel(e.target.value), spellCheck: false, style: { flex: '1 1 220px' } }),
        kit.actions(
          kit.btn(t('save'), () => { void go() }, { key: 'save', primary: true, disabled: busy }),
          secret !== undefined ? kit.btn(t('done'), onDone, { key: 'done' }) : null,
        ),
      ),
      secret !== undefined ? kit.note(t('tokenSecretShown').replace('{t}', secret.label !== '' ? secret.label : secret.id)) : null,
      secret !== undefined ? kit.mono(secret.secret) : null,
      err !== '' ? kit.error(err) : null,
    )
  }
}
