/**
 * The conversation「MCP」tab, bound to the REAL sessionId prop.
 *
 * Three clearly separated states (P5.8 / progress-review §4):
 *  - SNAPSHOT: the registration snapshot recorded when this session's tools
 *    were installed (registeredAt + tool list) — what is live NOW;
 *  - CURRENT: the merged config a NEXT session started right now would get;
 *  - PENDING: session-layer overrides (defs + disables) that only take
 *    effect for LATER sessions — never retroactively in this one.
 *
 * Session overrides here carry explicit inherit/disable semantics:
 *  - "Override in this session" writes a whole-entry replacement on
 *    session:overrides (masked secrets round-trip via the sentinel dialect);
 *  - "Disable for this session" writes a {disabled:true} tombstone;
 *  - "Remove override" deletes the override (= re-inherit the lower layer).
 *
 * "Start next session" uses a VERIFIED host action when the host exposes the
 * client 'sessions' service (create({cwd}) + open(sessionId), see
 * dsh-client-runtime SessionRuntime); when that face is absent the button is
 * disabled with an explanation — no unsupported navigation is promised.
 */
import type { ReactLike, Kit } from '../ui.js'
import { api, isNoRoute, type Preview, type PreviewEntry, type SessionView } from '../api.js'
import { buildSaveBody, classifySessionEntries, isConflictRejection } from '../scope.js'
import { makeEntryEditor, type EditorArgs } from './entry-editor.js'

type T = (key: string) => string

/** Result contract of the verified host action handed in by index.ts. */
export interface StartNextResult {
  ok: boolean
  reason?: 'sessions-unavailable' | 'no-cwd' | 'error'
  message?: string
}
export type StartNext = (sessionId: string) => Promise<StartNextResult>

export function makeSessionTab(React: ReactLike, kit: Kit): (props: { t: T; sessionId: string; startNext?: StartNext; probeSessions?: () => boolean }) => unknown {
  const EditorView = makeEntryEditor(React, kit)

  return function SessionMcpTab(props: { t: T; sessionId: string; startNext?: StartNext; probeSessions?: () => boolean }) {
    const t = props.t
    const sessionId = props.sessionId
    const [preview, setPreview] = React.useState<Preview | undefined>(undefined)
    const [session, setSession] = React.useState<SessionView | undefined>(undefined)
    const [snapshotErr, setSnapshotErr] = React.useState('')
    const [err, setErr] = React.useState('')
    const [editor, setEditor] = React.useState<EditorArgs | undefined>(undefined)
    const [note, setNote] = React.useState('')
    const [faceOk, setFaceOk] = React.useState<boolean | undefined>(undefined)
    React.useEffect(() => {
      // Real disabled state: probe the host face once at mount (post-boot, so
      // the registry read is meaningful); click-time checks stay authoritative.
      setFaceOk(props.probeSessions !== undefined ? props.probeSessions() : props.startNext !== undefined)
    }, [])
    const refresh = React.useCallback(async () => {
      setErr('')
      try {
        const p = await api.preview(sessionId !== '' ? { ss: sessionId } : undefined)
        setPreview(p)
      } catch (error) {
        setErr((error as { message?: string }).message ?? String(error))
      }
      setSession(undefined); setSnapshotErr('')
      try { setSession(await api.sessionView(sessionId)) }
      catch (error) { setSnapshotErr((error as { message?: string }).message ?? String(error)) }
    }, [sessionId])
    React.useEffect(() => { void refresh() }, [refresh])

    const sessionLayerRevision = (): string => {
      const layer = preview?.layers.find((l) => l.source === 'session')
      return layer?.revision ?? session?.revision ?? ''
    }
    const overrideCallbacks = {
      onCancel: () => setEditor(undefined),
      onSaved: () => { setEditor(undefined); void refresh() },
      onRevision: (revision: string) => setEditor((cur) => cur === undefined ? cur : { ...cur, revision }),
    }
    /** Whole-entry session override (initial text = the currently effective def). */
    const override = (entry: PreviewEntry) => {
      setEditor({
        t, mode: 'edit', name: entry.name,
        initial: JSON.stringify(entry.def, null, 2),
        layerId: 'session:overrides', level: 'session', source: 'session',
        revision: sessionLayerRevision(),
        ss: sessionId,
        ...overrideCallbacks,
      })
    }
    /** One session-layer write (def replacement or tombstone). */
    const writeOverride = async (name: string, def: Record<string, unknown> | null) => {
      try {
        await api.saveEntry(
          buildSaveBody({ layerId: 'session:overrides', level: 'session', source: 'session', revision: sessionLayerRevision() }, name, def),
          { ss: sessionId },
        )
        await refresh()
      } catch (error) {
        const msg = (error as { message?: string }).message ?? String(error)
        setNote(msg + (isConflictRejection(error) ? ' — ' + t('conflict') : ''))
      }
    }
    const startNext = async () => {
      if (props.startNext === undefined) return
      setNote('…')
      const out = await props.startNext(sessionId)
      if (out.ok) { setNote(t('startedNext')); return }
      if (out.reason === 'no-cwd') { setNote(t('startNextNoCwd')); return }
      if (out.reason === 'sessions-unavailable') { setFaceOk(false); setNote(t('startNextUnavailable')); return }
      setNote(t('startNextFailed') + (out.message !== undefined ? ': ' + out.message : ''))
    }

    if (sessionId === '') return kit.card(kit.note(t('noSessionId')))
    if (err !== '') return kit.card(kit.error(t('loadFailed') + ': ' + err), kit.note(t('reloadNeeded')), kit.btn(t('retry'), () => { void refresh() }))
    if (preview === undefined) return kit.note('…')
    const { pending, current } = classifySessionEntries(preview.entries)
    const snapshot = session?.snapshot
    const drift = pending.length
    return kit.h('div', { className: 'mmc-root' },
      kit.h('div', { className: 'mmc-head' }, kit.h('strong', {}, t('sessionTitle')),
        kit.h('span', { className: 'mmc-sub mmc-note' }, sessionId),
        kit.h('span', { className: 'mmc-spacer' }),
        kit.btn(t('refresh'), () => { void refresh() }),
      ),
      kit.note(t('sessionIntro')),
      // --- snapshot (what this session runs with right now) ------------------------------------
      kit.card(
        kit.h('div', { className: 'mmc-row' },
          kit.h('strong', {}, t('snapshotTitle')),
          snapshot !== undefined ? kit.tag(snapshot.registeredAt) : null,
          snapshot !== undefined ? kit.tag(String(snapshot.tools.length) + ' tools') : null,
          kit.h('span', { className: 'mmc-spacer' }),
        ),
        snapshot !== undefined
          ? kit.note(snapshot.tools.slice(0, 12).join(', ') + (snapshot.tools.length > 12 ? ' …' : ''))
          : snapshotErr !== ''
            ? kit.note(isNoRoute({ message: snapshotErr }) ? t('bridgePending') : t('snapshotMissing') + ' (' + snapshotErr + ')')
            : kit.note(t('snapshotMissing')),
        kit.note(t('snapshotHint')),
      ),
      // --- start next session (verified host action, or explicit disable) -----------------------
      kit.card(
        kit.h('div', { className: 'mmc-row' },
          kit.btn(t('startNext'), () => { void startNext() }, { primary: true, disabled: faceOk === false }),
          drift > 0 ? kit.tag(t('pendingCount').replace('{n}', String(drift)), 'info') : kit.tag(t('noDrift')),
        ),
        faceOk === false ? kit.note(t('startNextUnavailable')) : kit.note(t('startNextHint')),
        note !== '' ? kit.note(note) : null,
      ),
      preview.conflicts.length > 0 ? kit.error(t('conflicts') + ': ' + preview.conflicts.map((c) => c.name).join(', ')) : null,
      editor !== undefined ? kit.h(EditorView, { key: 'override-editor', args: editor }) : null,
      // --- current effective set (what the NEXT session would get) ------------------------------
      kit.section(t('currentTitle'), { sub: t('currentHint') },
        current.length === 0
          ? kit.empty(t('empty'))
          : kit.rows(...current.map((entry) => kit.row({
              key: entry.name,
              state: entry.disabled ? 'off' : 'ok',
              name: entry.name,
              badge: { text: entry.source === 'native' ? (entry.level + ':native') : entry.level },
              meta: kit.factsOf(
                String(entry.def.command ?? entry.def.url ?? entry.def.type ?? ''),
                entry.disabled ? t('disabled') : '',
              ),
              menuLabel: t('moreFor').replace('{n}', entry.name),
              menu: [
                { label: t('overrideHere'), onPick: () => override(entry) },
                // A disable that lives in a lower layer cannot be lifted from
                // here (removing a session override that does not exist
                // re-inherits the SAME disabled def) — fix it in the
                // workbench, at its source layer.
                { label: entry.disabled ? t('fixAtSource') : t('disableHere'), disabled: entry.disabled, onPick: () => { void writeOverride(entry.name, { disabled: true }) } },
              ],
            }))),
      ),
      // --- pending session overrides -------------------------------------------------------------
      kit.section(t('pendingTitle'), { sub: t('pendingHintLong') },
        pending.length === 0
          ? kit.empty(t('noOverrides'))
          : kit.rows(...pending.map((entry) => kit.row({
              key: entry.name,
              state: 'off',
              name: entry.name,
              badge: { text: 'session:overrides' },
              meta: kit.factsOf(entry.disabled ? t('disabled') : JSON.stringify(entry.def).slice(0, 60)),
              menuLabel: t('moreFor').replace('{n}', entry.name),
              menu: [
                { label: t('edit'), onPick: () => override(entry) },
                { label: t('removeOverride'), danger: true, onPick: () => { void writeOverride(entry.name, null) } },
              ],
            }))),
      ),
    )
  }
}
