/**
 * The one focused definition editor shared by the workbench and the session
 * tab. R5 contract:
 *  - the LAYER (layerId, or level+source fallback) and the REVISION are
 *    captured when the editor OPENS and are the ONLY addressing a save uses;
 *  - the save path NEVER re-reads the preview — an external change during
 *    editing surfaces as a 409, which keeps the draft text and offers an
 *    explicit "reload the layer, keep my draft" action;
 *  - the payload carries no filesystem paths (layerId only).
 *
 * The editor has two views over ONE source of truth (the JSON text): a typed
 * form driven by client/fields.ts, and the raw JSON. Keeping the text
 * authoritative is what makes switching views free and impossible to
 * desynchronise — the form reads it, edits fold back into it, and the save
 * path is unchanged. Text that does not parse simply has no form to show, and
 * the editor says so instead of rendering a form over a guess.
 */
import type { ReactLike, Kit } from '../ui.js'
import { view } from '../ui.js'
import { api, type LayerId } from '../api.js'
import { readEditorDocument } from '../editor-document.js'
import { buildSaveBody, findLayer, isConflictRejection, LAYER_NAME_KEYS } from '../scope.js'
import {
  applyField, fieldValue, fieldsFor, labelFor, retype, typeOfDef, typesFor, unknownKeys,
  type FieldSpec,
} from '../fields.js'

type T = (key: string) => string
let fieldSerial = 0

/** Keep uncommon options out of the connection's main setup path. */
function editorFields(type: string) {
  const fields = fieldsFor(type)
  const primary = type === 'stdio' ? ['command', 'args'] : type === 'proc' ? ['command'] : type === 'remote' || type === 'http' ? ['url', 'headers'] : undefined
  return { main: primary === undefined ? fields : fields.filter((f) => primary.includes(f.k)), advanced: primary === undefined ? [] : fields.filter((f) => !primary.includes(f.k)) }
}

function hasValue(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return false
  if (typeof value === 'object') return Object.keys(value).length > 0
  return true
}

/** Everything the editor freezes at OPEN time (R5). */
export interface EditorArgs {
  t: T
  mode: 'create' | 'edit'
  /** Entry name (fixed in edit mode; typed by the user in create mode). */
  name: string
  initial: string
  layerId?: LayerId
  level: string
  source: string
  /** Revision of the layer as it was when the editor opened. */
  revision: string
  ws?: string
  ss?: string
  onCancel: () => void
  onSaved: () => void
  /** After an explicit reload-and-merge, refresh the captured revision in place. */
  onRevision: (revision: string) => void
}


/**
 * One form field. It holds its own draft text so that a half-typed value
 * survives: a KEY=VALUE block, a number or a JSON array is meaningless
 * mid-keystroke, and folding it into the definition on every character would
 * erase what the user is typing. Those commit on blur; a plain string is
 * lossless, so it commits live.
 */
function FieldRow(
  React: ReactLike, kit: Kit,
  props: { lang: string; field: FieldSpec; value: string | boolean; onCommit: (value: string | boolean) => void },
) {
  const f = props.field
  // The draft is remembered against the value it was started from, so an
  // edit from OUTSIDE this field — the JSON tab, a type switch, the commit's
  // own normalisation — resyncs it, while typing does not fight itself.
  const [held, setHeld] = React.useState({ base: props.value, draft: props.value })
  const draft = held.base === props.value ? held.draft : props.value
  const take = (next: string | boolean) => setHeld({ base: props.value, draft: next })
  const label = props.lang === 'zh' ? f.zh : f.en
  const hint = props.lang === 'zh' ? f.hintZh : f.hintEn
  const [id] = React.useState(() => 'mcp-editor-field-' + String(++fieldSerial))
  const hintNode = hint !== undefined ? kit.h('div', { id: id + '-hint', className: 'mmc-hint', title: hint }, hint) : null
  if (f.bool === true) {
    // Full width, never half: a checkbox parked beside a text field reads as
    // an option OF that field rather than one of its own.
    return kit.h('div', { className: 'mmc-field' },
      kit.h('label', { className: 'mmc-check' },
        kit.h('input', {
          type: 'checkbox', checked: draft === true,
          ...(hint !== undefined ? { 'aria-describedby': id + '-hint' } : {}),
          onChange: (e: { target: { checked: boolean } }) => { take(e.target.checked); props.onCommit(e.target.checked) },
        }),
        label),
      hintNode)
  }
  const lossless = f.num !== true && f.kv !== true && f.list !== true && f.json !== true
  const placeholder = props.lang === 'zh' && f.phZh !== undefined ? f.phZh : f.ph
  const shared = {
    id, value: String(draft),
    ...(hint !== undefined ? { 'aria-describedby': id + '-hint' } : {}),
    spellCheck: false,
    ...(placeholder !== undefined ? { placeholder } : {}),
    onChange: (e: { target: { value: string } }) => { take(e.target.value); if (lossless) props.onCommit(e.target.value) },
    onBlur: () => { if (!lossless) props.onCommit(draft) },
  }
  return kit.h('div', { className: 'mmc-field', ...(f.half === true ? { 'data-half': 'true' } : {}) },
    kit.h('label', { htmlFor: id }, label),
    f.area === true ? kit.textarea({ ...shared, rows: f.k === 'args' ? 3 : 4, ...(f.kv === true || f.list === true || f.json === true ? { className: 'mmc-input mmc-editor-code' } : {}) }) : kit.input(shared),
    hintNode)
}

export function EntryEditor(React: ReactLike, kit: Kit, args: EditorArgs, FieldView: (props: never) => unknown) {
  const t = args.t
  const lang = t('__lang') === 'zh' ? 'zh' : 'en'
  // Session overrides are engine definitions too, not standard-file entries.
  const native = args.source === 'native' || args.source === 'session'
  const initial = readEditorDocument(args.initial, native)
  const [text, setText] = React.useState(initial?.def !== undefined ? JSON.stringify(initial.def, null, 2) : args.initial)
  const [name, setName] = React.useState(initial?.name ?? (args.mode === 'edit' ? args.name : ''))
  const [imported, setImported] = React.useState(initial?.name ?? '')
  const [tab, setTab] = React.useState<'form' | 'json'>('form')
  const [busy, setBusy] = React.useState(false)
  const [err, setErr] = React.useState('')
  const [conflict, setConflict] = React.useState(false)
  const [probe, setProbe] = React.useState('')
  const target = args.layerId !== undefined ? args.layerId : args.level + '/' + args.source
  const parsed = readEditorDocument(text, native)
  const def = parsed?.def
  const type = def !== undefined ? typeOfDef(def, args.layerId) : ''
  const offered = typesFor(args.layerId)
  const types = offered.includes(type) || type === '' ? offered : offered.concat([type])
  const extra = def !== undefined ? unknownKeys(def, type) : []
  const fields = editorFields(type)
  const [advancedOpen, setAdvancedOpen] = React.useState(() => fields.advanced.some((f) => hasValue(def?.[f.k])))
  const [typeId] = React.useState(() => 'mcp-editor-type-' + String(++fieldSerial))
  const renderFields = (list: FieldSpec[]) => list.map((field) => kit.h(FieldView, {
    key: type + ':' + field.k, lang, field, value: fieldValue(def ?? {}, field),
    onCommit: (value: string | boolean) => commit(field, value),
  } as never))
  /** Fold one field edit back into the draft. A bad number/JSON reports itself. */
  const commit = (field: FieldSpec, value: string | boolean) => {
    if (def === undefined) return
    setErr('')
    try { setText(JSON.stringify(applyField(def, field, value), null, 2)) }
    catch (error) { setErr(field.k + ': ' + ((error as { message?: string }).message ?? String(error))) }
  }
  /** Normalize a pasted client document once, with an explicit first-server hint. */
  const acceptJson = (value: string) => {
    const document = readEditorDocument(value, native)
    if (document?.def !== undefined && document.name !== undefined) {
      setText(JSON.stringify(document.def, null, 2))
      setName(document.name)
      setImported(document.name)
      const nextFields = editorFields(typeOfDef(document.def, args.layerId))
      setAdvancedOpen(nextFields.advanced.some((f) => hasValue(document.def?.[f.k])))
      setErr('')
    } else {
      setText(value)
      setImported('')
      setErr(document?.error !== undefined ? t(document.error) : '')
    }
  }
  /**
   * Probe the DRAFT before saving it. Nothing is written or hosted, so a
   * wrong password costs one message instead of a saved-then-broken entry.
   * Types without a probe say so rather than pretending to pass.
   */
  const test = React.useCallback(async () => {
    setBusy(true); setProbe(t('testRunning'))
    try {
      const draft = readEditorDocument(text, native)?.def
      if (draft === undefined) throw new Error(t('defNotObject'))
      const out = await api.mcpTest(draft)
      if (!out.testable) setProbe(t('testUntestable').replace('{types}', (out.types ?? []).join(' | ')))
      else if (out.ok === true) setProbe(t('testOk').replace('{ms}', String(out.ms ?? 0)) + (out.status !== undefined ? ' · HTTP ' + String(out.status) : ''))
      else setProbe(t('testFailed') + ': ' + String(out.error ?? ''))
    } catch (error) {
      setProbe(t('testFailed') + ': ' + ((error as { message?: string }).message ?? String(error)))
    } finally { setBusy(false) }
  }, [text])
  // R5: save uses ONLY what was captured at open (args.revision / args.layerId).
  // There is deliberately NO preview fetch on the save path.
  const go = React.useCallback(async () => {
    setBusy(true); setErr(''); setConflict(false)
    const nameForSave = name.trim()
    try {
      const document = readEditorDocument(text, native)
      const body = document?.def
      if (body === undefined) throw new Error(t(document?.error ?? 'defNotObject'))
      // Editing the name IS the rename: one round trip moves the definition
      // to the new name and drops the old one on the same layer.
      if (args.mode === 'edit' && nameForSave !== args.name) {
        if (args.layerId === undefined) throw new Error(t('renameNeedsLayer'))
        await api.renameEntry(
          { layerId: args.layerId, from: args.name, to: nameForSave, def: body, expectedRevision: args.revision },
          { ...(args.ws !== undefined && args.ws !== '' ? { ws: args.ws } : {}), ...(args.ss !== undefined && args.ss !== '' ? { ss: args.ss } : {}) },
        )
        args.onSaved()
        return
      }
      await api.saveEntry(
        buildSaveBody(
          { ...(args.layerId !== undefined ? { layerId: args.layerId } : {}), level: args.level, source: args.source, revision: args.revision },
          nameForSave,
          body,
        ),
        { ...(args.ws !== undefined && args.ws !== '' ? { ws: args.ws } : {}), ...(args.ss !== undefined && args.ss !== '' ? { ss: args.ss } : {}) },
      )
      args.onSaved()
    } catch (error) {
      if (isConflictRejection(error)) setConflict(true)
      else setErr((error as { message?: string }).message ?? String(error))
    } finally { setBusy(false) }
  }, [text, name, args])
  /** Explicit, user-initiated: re-read the layer for its new revision, keep the draft text. */
  const reloadLayer = React.useCallback(async () => {
    setBusy(true); setErr('')
    try {
      const p = await api.preview({ ...(args.ws !== undefined && args.ws !== '' ? { ws: args.ws } : {}), ...(args.ss !== undefined && args.ss !== '' ? { ss: args.ss } : {}) })
      const layer = args.layerId !== undefined
        ? findLayer(p, args.layerId)
        : p.layers.find((l) => l.level === args.level && l.source === args.source)
      if (layer === undefined) { setErr(t('layerGone')); return }
      args.onRevision(layer.revision)
      setConflict(false)
    } catch (error) {
      setErr((error as { message?: string }).message ?? String(error))
    } finally { setBusy(false) }
  }, [])
  const title = args.mode === 'create' ? t('addMcp') : t('editorEditTitle')
  const typeLabel = (value: string) => value === 'stdio' || value === 'proc' ? t('editorTypeLocal') : value === 'remote' || value === 'http' ? t('editorTypeRemote') : labelFor(value, lang)
  const chevron = kit.h('svg', { viewBox: '0 0 16 16', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, 'aria-hidden': 'true' }, kit.h('path', { d: 'M4.5 6L8 9.5 11.5 6', strokeLinecap: 'round', strokeLinejoin: 'round' }))
  return kit.h('section', { className: 'mmc-editor', 'aria-label': title },
    kit.h('div', { className: 'mmc-editor-header' },
      kit.h('div', { className: 'mmc-editor-heading' },
        kit.h('h3', {}, title),
        kit.h('div', { className: 'mmc-editor-source', title: target + ' · rev ' + (args.revision || '∅') }, t(LAYER_NAME_KEYS[target] ?? target))),
      kit.tabs([{ key: 'form', label: t('formTab') }, { key: 'json', label: t('jsonTab') }], tab, (k) => setTab(k as 'form' | 'json')),
    ),
    kit.h('div', { className: 'mmc-editor-body' },
      kit.h('div', { className: 'mmc-editor-basics', 'data-json': tab === 'json' ? 'true' : undefined },
        kit.h('div', { className: 'mmc-field' }, kit.h('label', { className: 'mmc-editor-name-label' }, t('name'),
          kit.input({ value: name, placeholder: t('editorNamePlaceholder'), onChange: (e: { target: { value: string } }) => setName(e.target.value), spellCheck: false }))),
        tab === 'form' && def !== undefined ? kit.h('div', { className: 'mmc-field' },
          kit.h('label', { htmlFor: typeId }, t('connType')),
          kit.h('div', { className: 'mmc-editor-select' }, kit.select({
            id: typeId, value: type,
            onChange: (e: { target: { value: string } }) => { setText(JSON.stringify(retype(def, type, e.target.value), null, 2)); setAdvancedOpen(false); setImported('') },
          }, types.map((x) => kit.h('option', { key: x, value: x }, typeLabel(x)))), chevron)) : null,
      ),
      args.mode === 'edit' && name.trim() !== args.name ? kit.note(t('willRename')) : null,
      imported !== '' ? kit.h('div', { className: 'mmc-editor-imported', role: 'status' }, t('editorJsonLoaded').replace('{name}', imported)) : null,
      tab === 'form' && def === undefined ? kit.error(t(parsed?.error ?? 'defNotObject')) : null,
      tab === 'form' && def !== undefined ? kit.h('div', { className: 'mmc-fields' }, renderFields(fields.main)) : null,
      tab === 'form' && def !== undefined && fields.advanced.length > 0 ? kit.h('details', {
        className: 'mmc-editor-advanced', open: advancedOpen, onToggle: (e: { currentTarget: { open: boolean } }) => setAdvancedOpen(e.currentTarget.open),
      }, kit.h('summary', {}, kit.h('span', {}, t('editorAdvanced')), kit.h('span', { className: 'mmc-editor-optional' }, t('editorOptional')), kit.h('span', { className: 'mmc-editor-disclosure' }, chevron)),
        kit.h('div', { className: 'mmc-fields' }, renderFields(fields.advanced))) : null,
      tab === 'form' && extra.length > 0 ? kit.note(t('extraKeys').replace('{n}', String(extra.length)) + ' (' + extra.join(', ') + ')') : null,
      tab === 'json' ? kit.h('div', { className: 'mmc-editor-json' },
        kit.note(t('editorJsonHint')),
        kit.textarea({ className: 'mmc-input mmc-editor-code', value: text, rows: 12, onChange: (e: { target: { value: string } }) => acceptJson(e.target.value), 'aria-label': t('editorJsonLabel'), spellCheck: false })) : null,
      probe !== '' ? kit.h('div', { className: 'mmc-editor-feedback', role: 'status' }, probe) : null,
      conflict ? kit.error(t('conflict')) : null,
      conflict ? kit.h('div', { className: 'mmc-editor-conflict' }, kit.btn(t('reloadLayerKeepDraft'), () => { void reloadLayer() }, { disabled: busy }), kit.note(t('conflictHint'))) : null,
      err !== '' ? kit.error(err) : null,
    ),
    kit.h('div', { className: 'mmc-editor-footer' },
      kit.btn(t('test'), () => { void test() }, { disabled: busy }),
      kit.actions(kit.btn(t('cancel'), args.onCancel), kit.btn(t('save'), () => { void go() }, { primary: true, disabled: busy || name.trim().length === 0 }))),
  )
}

/** Stable component identity for the (conditionally rendered) editor. */
export function makeEntryEditor(React: ReactLike, kit: Kit): (props: { args: EditorArgs }) => unknown {
  // One identity for every field row, created once per (React, kit) binding —
  // the rows render conditionally and in a list, and each one holds state.
  const FieldView = view<{ lang: string; field: FieldSpec; value: string | boolean; onCommit: (value: string | boolean) => void }>(
    React, (props) => FieldRow(React, kit, props))
  return view<{ args: EditorArgs }>(React, (props) => EntryEditor(React, kit, props.args, FieldView as (props: never) => unknown))
}
