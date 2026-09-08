/**
 * Advanced page: named-token CRUD (create / reveal / rotate / revoke — each an
 * EXPLICIT action), sealed env-var CRUD (write-only values), backup export /
 * restore behind explicit confirmations, the skill/creds equivalences, the
 * legacy-gateway migration, and engine diagnostics.
 *
 * Destructive or credential-affecting actions always confirm first; restore
 * additionally distinguishes merge vs replace modes.
 *
 * Layout: each concern is a SECTION — a label, one line of what it is, and its
 * own actions — not a bordered card. Six stacked boxes, each cramming a title,
 * a sentence and two buttons onto one 560px line, is what made this page read
 * as a wall of settings with no shape.
 */
import type { ReactLike, Kit } from '../ui.js'
import { view } from '../ui.js'
import { api, isNoRoute, type BackupDocument, type ListenerState, type RestoreResult, type TokenRow, type TokenSecret } from '../api.js'

type T = (key: string) => string

/** An ISO timestamp in a list is noise; the day is the part anyone reads. */
function shortDate(iso: string | undefined): string {
  if (iso === undefined || iso === '') return ''
  return iso.length >= 10 ? iso.slice(0, 10) : iso
}

export function makeAdvancedPage(React: ReactLike, kit: Kit): (props: { t: T }) => unknown {
  // Stable identities for the conditionally-rendered hook-using forms.
  const TokenCreateView = view<{ t: T; onDone: () => void }>((React), (props) => TokenCreateForm(React, kit, props.t, props.onDone))
  const EnvFormView = view<{ t: T; name: string; onDone: () => void }>((React), (props) => EnvForm(React, kit, props.t, props.name, props.onDone))
  const RestoreView = view<{ t: T; onDone: (result?: RestoreResult) => void }>((React), (props) => RestoreForm(React, kit, props.t, props.onDone))

  return function AdvancedPage(props: { t: T }) {
    const t = props.t
    // tokens
    const [tokens, setTokens] = React.useState<TokenRow[] | undefined>(undefined)
    const [tokenErr, setTokenErr] = React.useState('')
    const [shown, setShown] = React.useState<TokenSecret | undefined>(undefined)
    const [creatingToken, setCreatingToken] = React.useState(false)
    // env. `envEdit` is the NAME being edited; '' opens a blank form, undefined
    // closes it. Update used to open the same empty form as Add, so "update
    // SEARCH_API_KEY" asked the user to retype the name the panel already knew.
    const [env, setEnv] = React.useState<string[] | undefined>(undefined)
    const [envErr, setEnvErr] = React.useState('')
    const [envEdit, setEnvEdit] = React.useState<string | undefined>(undefined)
    // backup
    const [backup, setBackup] = React.useState<BackupDocument | undefined>(undefined)
    const [backupErr, setBackupErr] = React.useState('')
    const [restoring, setRestoring] = React.useState(false)
    const [restoreOut, setRestoreOut] = React.useState<RestoreResult | undefined>(undefined)
    // skill / creds, migration and diagnostics each keep their OWN output line.
    // They shared one, so measuring the process tree wiped the migration plan's
    // message and vice versa.
    const [skillNote, setSkillNote] = React.useState('')
    const [dir, setDir] = React.useState('')
    const [plan, setPlan] = React.useState<Record<string, unknown> | undefined>(undefined)
    const [migrateNote, setMigrateNote] = React.useState('')
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
    const loadEnv = React.useCallback(async () => {
      setEnvErr(''); setEnv(undefined)
      try { setEnv((await api.envList()).vars.map((v) => v.name)) } catch (error) { setEnvErr((error as { message?: string }).message ?? String(error)) }
    }, [])
    React.useEffect(() => { void loadTokens(); void loadEnv(); void loadEndpoint() }, [loadTokens, loadEnv, loadEndpoint])

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
    const envDelete = async (name: string) => {
      if (!confirm(t('confirmEnvDelete').replace('{k}', name))) return
      try { await api.envDelete(name); await loadEnv() } catch (error) { setEnvErr((error as { message?: string }).message ?? String(error)) }
    }
    const exportBackup = async () => {
      setBackupErr(''); setBackup(undefined)
      try {
        const doc = await api.backupExport()
        setBackup(doc)
        // Browser download of the same document we display.
        try {
          const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = 'dsh-mcp-backup-' + doc.generatedAt.replace(/[:.]/g, '-') + '.json'
          a.click()
          URL.revokeObjectURL(url)
        } catch { /* non-browser context: the mono view below still shows it */ }
      } catch (error) { setBackupErr((error as { message?: string }).message ?? String(error)) }
    }
    const doPlan = React.useCallback(async () => {
      setMigrateNote('…')
      try { setPlan(await callJson('GET', '/migration/plan?dir=' + encodeURIComponent(dir))); setMigrateNote('') } catch (error) { setMigrateNote((error as { message?: string }).message ?? String(error)) }
    }, [dir])
    const doApply = React.useCallback(async () => {
      if (!confirm(t('confirmMigrate'))) return
      setMigrateNote('…')
      try { setPlan({ applied: await callJson('POST', '/migration/apply', { dir }) }); setMigrateNote('') } catch (error) { setMigrateNote((error as { message?: string }).message ?? String(error)) }
    }, [dir])

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

      // --- sealed env vars (write-only values) ---
      kit.section(t('envTitle'), {
        sub: t('envIntro'),
        actions: [
          kit.btn(t('refresh'), () => { void loadEnv() }, { key: 'refresh' }),
          kit.btn(t('envNew'), () => { setEnvEdit(envEdit === '' ? undefined : '') }, { key: 'new', primary: true }),
        ],
      },
        envErr !== '' ? kit.error(isNoRoute({ message: envErr }) ? t('bridgePending') : envErr) : null,
        env === undefined && envErr === '' ? kit.note('…') : null,
        envEdit !== undefined
          ? kit.h(EnvFormView, { key: 'env-form-' + envEdit, t, name: envEdit, onDone: () => { setEnvEdit(undefined); void loadEnv() } })
          : null,
        env !== undefined && env.length === 0 ? kit.empty(t('noEnv')) : null,
        env !== undefined && env.length > 0
          ? kit.rows(...env.map((name) => kit.row({
              key: name,
              name,
              // The dots ARE the value column: they say a value exists and
              // that the panel will not show it. Spelling "write-only" out
              // again on every row only repeats the section's own footnote.
              badge: { text: '••••', tone: 'off' },
              menuLabel: t('moreFor').replace('{n}', name),
              menu: [
                { label: t('envEdit'), onPick: () => { setEnvEdit(name) } },
                { label: t('envDelete'), danger: true, onPick: () => { void envDelete(name) } },
              ],
            })))
          : null,
      ),

      // --- backup export / restore (explicit confirmations) ---
      // Every section on this page is the same shape: a short label, ONE
      // bordered group, a footnote. Four of them used to be a heading with
      // loose buttons beside it and nothing enclosing them, so half the page
      // had cards and half floated — the reason it read as six unrelated
      // toolbars rather than one settings page.
      kit.section(t('backupTitle'), { sub: t('backupIntro') },
        kit.rows(
          kit.row({
            key: 'export',
            name: t('rowBackupExport'),
            action: { label: t('backupExport'), onPick: () => { void exportBackup() }, primary: true },
          }),
          kit.row({
            key: 'restore',
            name: t('rowBackupRestore'),
            action: { label: t('backupRestore'), onPick: () => { setRestoring(!restoring) } },
          }),
        ),
        backupErr !== '' ? kit.error(isNoRoute({ message: backupErr }) ? t('bridgePending') : backupErr) : null,
        restoring
          ? kit.h(RestoreView, {
              key: 'restore',
              t,
              onDone: (result?: RestoreResult) => { setRestoring(false); if (result !== undefined) { setRestoreOut(result) } },
            })
          : null,
        restoreOut !== undefined ? kit.note(t('restoreDone') + ' ' + JSON.stringify(restoreOut.restored)) : null,
        backup !== undefined ? kit.note(t('backupExported').replace('{d}', backup.generatedAt)) : null,
        backup !== undefined ? kit.mono(JSON.stringify(backup, null, 2).slice(0, 4000)) : null,
      ),

      // --- skill install + creds (lmg skill install / lmg creds equivalents) ---
      kit.section(t('skillTitle'), { sub: t('skillHint') },
        kit.rows(
          kit.row({
            key: 'install',
            name: t('rowSkillInstall'),
            action: {
              label: t('skillInstall'),
              primary: true,
              onPick: () => {
                setSkillNote(t('skillInstalling'))
                void callJson('POST', '/skill/install')
                  .then((j) => setSkillNote(t('skillInstalled').replace('{n}', String((j as { installed?: string[] })?.installed?.length ?? 0))))
                  .catch((e) => setSkillNote(String(e)))
              },
            },
          }),
          kit.row({
            key: 'creds',
            name: t('rowCreds'),
            action: {
              label: t('showCreds'),
              onPick: () => {
                setSkillNote(t('credsReading'))
                void callJson('GET', '/creds').then((j) => setSkillNote(String((j as { url?: string }).url) + ' · ' + String((j as { token?: string }).token))).catch((e) => setSkillNote(String(e)))
              },
            },
          }),
        ),
        skillNote !== '' ? kit.note(skillNote) : null,
      ),

      // --- legacy migration (old gateway data dir) ---
      // The two buttons stay WITH the field they act on: parked in the section
      // header they sat above the input, so the reader typed a path and then
      // had to go back up a line to run it.
      // The field and its label belong on the SAME line, and the verbs belong
      // in the section header the way Tokens and Env vars put theirs: the
      // split-out version put a naked input on its own row under a label row
      // that had the buttons, so the group read as two unrelated lines.
      kit.section(t('migrateTitle'), {
        sub: t('migrateIntro'),
        actions: [
          kit.btn(t('migratePlan'), () => { void doPlan() }, { key: 'plan', disabled: dir === '' }),
          // Apply is always PRESENT and disabled until a plan exists, rather
          // than appearing out of nowhere once one does.
          kit.btn(t('migrateApply'), () => { void doApply() }, { key: 'apply', primary: true, disabled: dir === '' || plan === undefined }),
        ],
      },
        kit.rows(kit.row({
          key: 'dir',
          name: t('rowMigrateDir'),
          extra: kit.input({
            placeholder: t('migratePlaceholder'), value: dir, spellCheck: false,
            'aria-label': t('rowMigrateDir'),
            onChange: (e: { target: { value: string } }) => setDir(e.target.value),
            style: { flex: '1 1 200px' },
          }),
        })),
        migrateNote !== '' ? kit.note(migrateNote) : null,
        plan !== undefined ? kit.mono(JSON.stringify(plan, null, 2).slice(0, 4000)) : null,
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

  /**
   * Add or update ONE sealed variable. When `initial` names an existing
   * variable the name is FIXED — this form is then "set a new value for THIS
   * name", and letting the field be retyped would quietly create a second
   * variable instead of updating the one the user clicked.
   */
  function EnvForm(React: ReactLike, kit: Kit, t: T, initial: string, onDone: () => void) {
    const [name, setName] = React.useState(initial)
    const [value, setValue] = React.useState('')
    const [busy, setBusy] = React.useState(false)
    const [err, setErr] = React.useState('')
    const fixed = initial !== ''
    const go = async () => {
      setBusy(true); setErr('')
      try { await api.envSet(name.trim(), value); onDone() } catch (error) { setErr((error as { message?: string }).message ?? String(error)) }
      finally { setBusy(false) }
    }
    return kit.card(
      kit.h('div', { className: 'mmc-row' },
        kit.input({
          placeholder: 'NAME', value: name, spellCheck: false, readOnly: fixed,
          onChange: (e: { target: { value: string } }) => setName(e.target.value),
        }),
        kit.input({ placeholder: t('envValue'), value, onChange: (e: { target: { value: string } }) => setValue(e.target.value), type: 'password', spellCheck: false }),
        kit.actions(
          kit.btn(t('save'), () => { void go() }, { key: 'save', primary: true, disabled: busy || name.trim().length === 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name.trim()) }),
          kit.btn(t('cancel'), onDone, { key: 'cancel' }),
        ),
      ),
      err !== '' ? kit.error(err) : null,
      kit.h('div', { className: 'mmc-hint' }, t('envWriteOnly')),
    )
  }

  function RestoreForm(React: ReactLike, kit: Kit, t: T, onDone: (result?: RestoreResult) => void) {
    const [text, setText] = React.useState('')
    const [mode, setMode] = React.useState<'merge' | 'replace'>('merge')
    const [busy, setBusy] = React.useState(false)
    const [err, setErr] = React.useState('')
    const go = async () => {
      setBusy(true); setErr('')
      let payload: Record<string, unknown>
      try { payload = JSON.parse(text) as Record<string, unknown> } catch (error) { setErr((error as Error).message); setBusy(false); return }
      const msg = mode === 'replace' ? t('confirmRestoreReplace') : t('confirmRestoreMerge')
      if (!confirm(msg)) { setBusy(false); return }
      // The result says WHAT was restored and what was skipped. It used to be
      // thrown away, so a restore finished by closing the form and showing
      // nothing at all.
      try { onDone(await api.backupRestore(payload, mode)) } catch (error) { setErr((error as { message?: string }).message ?? String(error)) }
      finally { setBusy(false) }
    }
    return kit.card(
      kit.note(t('restorePaste')),
      kit.textarea({ value: text, onChange: (e: { target: { value: string } }) => setText(e.target.value), spellCheck: false }),
      kit.h('div', { className: 'mmc-row' },
        kit.select({ value: mode, onChange: (e: { target: { value: string } }) => setMode(e.target.value === 'replace' ? 'replace' : 'merge') },
          kit.h('option', { value: 'merge' }, t('restoreMerge')), kit.h('option', { value: 'replace' }, t('restoreReplace'))),
        kit.actions(
          kit.btn(t('backupRestore'), () => { void go() }, { key: 'go', primary: true, disabled: busy || text.trim().length === 0 }),
          kit.btn(t('cancel'), () => onDone(), { key: 'cancel' }),
        ),
      ),
      err !== '' ? kit.error(err) : null,
    )
  }
}

/** Small local fetch helper for the two legacy routes not worth typing fully. */
async function callJson(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch('/dsh-mcp-manager' + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) throw new Error(String(json.error ?? res.statusText))
  return json
}
