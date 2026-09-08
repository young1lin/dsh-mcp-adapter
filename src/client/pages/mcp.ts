/**
 * The MCP workbench page: scope preview, entry CRUD (create + EDIT/DELETE of
 * existing entries on the layer they were read from), engine card + detail
 * tabs including a per-MCP Calls tab.
 *
 * R5 rules implemented here:
 *  - the editor retains the LAYER (layerId, falling back to level+source) and
 *    the REVISION captured when it was OPENED;
 *  - saving NEVER re-reads the preview — a 409 keeps the draft and offers an
 *    explicit reload-and-merge action;
 *  - save payloads address layers by layerId only — no filesystem paths.
 *
 * Hook safety: every hook-using subtree that renders conditionally is a
 * STABLE component identity created once per (React, kit) binding via
 * view(...) — never a direct conditional function call.
 */
import type { ReactLike, Kit } from '../ui.js'
import { view } from '../ui.js'
import {
  api, isNoRoute,
  type CallSource, type CallsPage, type ImportPreview, type ImportResult, type LayerId, type Preview, type PreviewEntry,
  type ScopeIds, type ToolRun, type ViewMeta, type WorkspaceItem,
} from '../api.js'
import {
  buildSaveBody, captureFromEntry, captureFromLayer, createTargetsFor, findLayer,
  layerIdOfEntry,
} from '../scope.js'
import { makeEntryEditor, type EditorArgs } from './entry-editor.js'
import { sortEntries } from '../../shared/view-order.js'
import { parseSessionInstance } from '../../shared/instance-name.js'
import { blankDef, typeOfDef, typesFor } from '../fields.js'
import {
  ArgError, applyArg, argFieldsOf, argValue, missingRequired, parseArgs, undeclaredKeys,
  type ArgField,
} from '../tool-args.js'

type T = (key: string) => string

interface Load { preview?: Preview; error?: string; busy: boolean }

/**
 * The reply as a READER sees it.
 *
 * An MCP text result is stored JSON-encoded, so a log row otherwise shows
 * `"[{\"title\":\"...` — three levels of escaping before the first real word.
 * Decode the outer string when there is one, fold whitespace, and clip.
 */
const JSON_ESCAPE: Record<string, string> = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }

function replyPreview(output: string | undefined, max = 80): string {
  if (typeof output !== 'string' || output === '') return ''
  let text = output
  if (text.startsWith('"')) {
    try {
      const decoded: unknown = JSON.parse(text)
      if (typeof decoded === 'string') text = decoded
    } catch {
      // The engine stores a CLIPPED reply, so the JSON string usually has no
      // closing quote left to parse — which is the normal case, not the odd
      // one. Undo what a JSON string escapes, by hand, so a clipped reply
      // reads as text like any other.
      text = text.slice(1)
        .replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/\\(.)/g, (_m, ch: string) => JSON_ESCAPE[ch] ?? ch)
    }
  }
  return text.replace(/\s+/g, ' ').slice(0, max)
}

/** One decode of a JSON string LITERAL; the value unchanged when it is not one. */
function unwrapJsonString(text: string): string {
  if (!text.startsWith('"')) return text
  try {
    const decoded: unknown = JSON.parse(text)
    return typeof decoded === 'string' ? decoded : text
  } catch {
    return text
  }
}

/** Pretty-print text that IS a JSON object or array; anything else as it stands. */
function prettyIfJson(text: string): string {
  const trimmed = text.trim()
  if (trimmed === '' || (trimmed[0] !== '{' && trimmed[0] !== '[')) return text
  try {
    const value: unknown = JSON.parse(trimmed)
    return value !== null && typeof value === 'object' ? JSON.stringify(value, null, 2) : text
  } catch {
    return text
  }
}

/** One content block, as something to read. */
function blockText(block: Record<string, unknown>): string {
  const kind = typeof block.type === 'string' ? block.type : 'unknown'
  if (kind === 'text' && typeof block.text === 'string') return prettyIfJson(unwrapJsonString(block.text))
  const resource = block.resource
  if (kind === 'resource' && resource !== null && typeof resource === 'object') {
    const r = resource as { uri?: unknown; text?: unknown }
    const head = typeof r.uri === 'string' ? r.uri : kind
    return typeof r.text === 'string' ? head + '\n' + prettyIfJson(unwrapJsonString(r.text)) : head
  }
  // image / audio / blob: the payload is base64, and pasting a megabyte of it
  // into the box is not showing it. Say what arrived and how big it was.
  const mime = typeof block.mimeType === 'string' ? block.mimeType : ''
  const data = typeof block.data === 'string' ? block.data : ''
  const kb = data === '' ? '' : ', ' + String(Math.max(1, Math.round(data.length * 3 / 4 / 1024))) + ' KB'
  return '[' + kind + (mime === '' ? '' : ' ' + mime) + kb + ']'
}

/**
 * A tool reply as a READER wants it, not as the wire carries it.
 *
 * The box used to show `JSON.stringify(content, null, 2)`, which is the reply
 * wrapped in its own transport: the `[{"type":"text","text":…}]` envelope,
 * and every newline inside re-escaped. Servers that answer with JSON *as
 * text* — URL readers commonly do — arrive already string-encoded, so
 * re-encoding made a document read `\\\\n` between every line.
 *
 * So: unwrap the envelope, decode one layer of string encoding when the text
 * IS a JSON string literal, and pretty-print what is left if it parses as
 * JSON. Newlines inside a JSON string VALUE stay escaped, because there they
 * are data — inventing line breaks in a value would be a different document.
 */
function replyText(result: unknown): string {
  if (result === null || typeof result !== 'object') return String(result ?? '')
  const r = result as { content?: unknown; structuredContent?: unknown }
  const blocks = Array.isArray(r.content) ? r.content : []
  const text = blocks
    .map((b) => (b !== null && typeof b === 'object' ? blockText(b as Record<string, unknown>) : String(b)))
    .filter((part) => part !== '')
    .join('\n\n')
  if (text !== '') return text
  if (r.structuredContent !== undefined) return JSON.stringify(r.structuredContent, null, 2)
  return JSON.stringify(result, null, 2)
}

/**
 * One recorded call, laid out.
 *
 * This was a `JSON.stringify` of the whole record, which put the three things
 * a reader actually wants — when, what went in, what came back — inside a
 * transport dump, with the arguments escaped a second time because they are
 * stored AS a JSON string. Facts belong in a facts grid; the two documents
 * belong under their own headings, decoded.
 */
function CallDetail(kit: Kit, t: T, call: Record<string, unknown>) {
  const str = (key: string): string => (typeof call[key] === 'string' ? call[key] : '')
  const args = prettyIfJson(unwrapJsonString(str('args')))
  const output = prettyIfJson(unwrapJsonString(str('output')))
  const clipped = call.preview === true && typeof call.chars === 'number'
  return kit.h('div', { className: 'mmc-section' },
    kit.h('div', { className: 'mmc-grid' },
      kit.kv(t('histResult'), call.ok === false ? '✗' : '✓'),
      kit.kv('tool', str('tool') === '' ? '—' : str('tool')),
      kit.kv(t('source'), str('via') === '' ? '—' : str('via') + (str('client') === '' ? '' : ' · ' + str('client'))),
      kit.kv('at', shortTime(str('at'))),
      kit.kv('ms', typeof call.ms === 'number' ? String(call.ms) : '—'),
      kit.kv('#', typeof call.seq === 'number' ? String(call.seq) : '—'),
    ),
    args === '' ? null : kit.h('div', { className: 'mmc-label' }, t('argsForm')),
    args === '' ? null : kit.mono(args),
    output === '' ? null : kit.h('div', { className: 'mmc-label' }, t('histResult')),
    output === '' ? null : kit.mono(output),
    // The engine stores only the head of a long reply; saying so beats letting
    // a document look like it simply stops mid-sentence.
    clipped ? kit.note(t('replyClipped').replace('{n}', String(call.chars))) : null,
  )
}

/**
 * An ISO timestamp as the part a reader actually scans.
 * A log row is read for "when, relative to the other rows"; the date repeats
 * on every line and the timezone offset never varies.
 */
function shortTime(iso: string | undefined): string {
  if (typeof iso !== 'string' || iso === '') return ''
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(iso)
  return m === null ? iso : m[2]!
}

// --- detail tab bodies (hook-free ones render directly) ----------------------------------------

function StatusBody(kit: Kit, t: T, data: Record<string, unknown>) {
  return kit.h('div', { className: 'mmc-grid' },
    kit.kv(t('lifecycle'), data.lifecycle ?? '—'), kit.kv(t('state'), data.state ?? '—'),
    kit.kv(t('type'), data.type ?? '—'), kit.kv(t('reason'), data.reason ?? '—'),
    kit.kv(t('pids'), Array.isArray(data.pids) ? (data.pids as number[]).join(',') : '—'),
  )
}

function ToolsBody(kit: Kit, data: Record<string, unknown>, onToggle: (tool: string, enabled: boolean) => void) {
  const tools = (data.tools as Array<{ name: string; description?: string }>) ?? []
  const disabled = new Set((data.disabledTools as string[]) ?? [])
  // A disabled tool is ABSENT from the served list — that is what disabling it
  // does — and the engine names it separately in `disabledTools` for exactly
  // this reason. Rendering only the served list therefore made the switch
  // one-way: flipping it off removed the row, and with it the only way back on.
  // The description is genuinely gone (only the live list carries one), but a
  // name is all a toggle row needs. Appended rather than merged in place: the
  // served order is the remote's, and there is no position in it for a tool it
  // is no longer telling us about.
  const rows = [
    ...tools,
    ...[...disabled].filter((name) => !tools.some((tool) => tool.name === name)).map((name) => ({ name, description: undefined })),
  ]
  if (rows.length === 0) return kit.note('—')
  // An "on"/"off" button had to be read before it could be understood: the
  // label named the action, so the state was whatever the label was not.
  return kit.rows(...rows.map((tool) => kit.row({
    key: tool.name,
    name: tool.name,
    meta: (tool.description ?? '').slice(0, 90),
    toggle: { on: !disabled.has(tool.name), label: tool.name, onChange: () => onToggle(tool.name, !disabled.has(tool.name)) },
  })))
}

/**
 * Resources/prompts list. A resource row is clickable when onOpen is given:
 * the engine has answered mcp.resourceRead all along, so listing a resource
 * without being able to open it was a dead end.
 */
function ListBody(kit: Kit, t: T, data: Record<string, unknown>, kind: 'resources' | 'prompts', onOpen?: (uri: string) => void) {
  const items = (data[kind] as Array<Record<string, unknown>>) ?? []
  if (items.length === 0) return kit.note('—')
  void t
  return kit.rows(...items.slice(0, 30).map((item, i) => {
    const uri = typeof item.uri === 'string' ? item.uri : ''
    const openable = onOpen !== undefined && uri !== ''
    return kit.row({
      key: String(i),
      name: String(item.name ?? item.uri ?? i),
      meta: String(item.description ?? item.mimeType ?? '').slice(0, 100),
      // The row IS the open affordance when there is something to open.
      onOpen: openable ? () => onOpen(uri) : undefined,
    })
  }))
}

/** One tool argument, rendered from its own schema entry. */
function ArgRow(
  React: ReactLike, kit: Kit,
  props: { field: ArgField; value: string | boolean; onCommit: (value: string | boolean) => void },
) {
  const f = props.field
  // Same held-draft rule as the entry editor's fields: an edit from OUTSIDE
  // this input (the JSON view, a tool switch, reusing a past call) resyncs
  // the box, while typing into it does not fight itself.
  const [held, setHeld] = React.useState({ base: props.value, draft: props.value })
  const draft = held.base === props.value ? held.draft : props.value
  const take = (next: string | boolean) => setHeld({ base: props.value, draft: next })
  const label = f.k + (f.required ? ' *' : '') + ' · ' + f.kind
  // A generated form shows the SERVER's own prose. One real search schema, for
  // one, packs its whole enum listing into `description` — six lines per
  // argument, which in a two-column grid buried every 28px input under a wall
  // of grey text and left the rows ragged. Clamp to two lines and put the
  // whole thing in the tooltip: the input is what the reader came for.
  const hint = f.description !== undefined
    ? kit.h('div', { className: 'mmc-hint', 'data-clamp': 'true', title: f.description }, f.description)
    : null
  if (f.kind === 'boolean') {
    return kit.h('div', { className: 'mmc-field' },
      kit.h('label', { className: 'mmc-check' },
        kit.h('input', {
          type: 'checkbox', checked: draft === true,
          onChange: (e: { target: { checked: boolean } }) => { take(e.target.checked); props.onCommit(e.target.checked) },
        }),
        label),
      hint)
  }
  if (f.choices !== undefined) {
    // The blank first option is how "leave this argument out" stays reachable
    // once the box can only hold values the schema allows.
    return kit.h('div', { className: 'mmc-field' },
      kit.h('label', {}, label),
      kit.select({
        value: String(draft),
        onChange: (e: { target: { value: string } }) => { take(e.target.value); props.onCommit(e.target.value) },
      }, [kit.h('option', { key: '', value: '' }, '—')].concat(
        f.choices.map((choice) => kit.h('option', { key: choice, value: choice }, choice)))),
      hint)
  }
  // Every non-string kind is lossy mid-keystroke (a half-typed number, a
  // half-typed JSON object), so those commit on blur; plain text is lossless
  // and commits live.
  const lossless = f.kind === 'string' && !f.area
  const shared = {
    value: String(draft),
    spellCheck: false,
    ...(f.placeholder !== undefined ? { placeholder: f.placeholder } : {}),
    onChange: (e: { target: { value: string } }) => { take(e.target.value); if (lossless) props.onCommit(e.target.value) },
    onBlur: () => { if (!lossless) props.onCommit(draft) },
  }
  // Full width, always. Half-width columns are 228px in this pane, which is
  // narrower than most of these argument names and far narrower than their
  // descriptions.
  return kit.h('div', { className: 'mmc-field' },
    kit.h('label', {}, label),
    f.area ? kit.textarea(shared) : kit.input(shared),
    hint)
}

/**
 * Run tab: pick a tool, fill in ITS arguments, send the call.
 *
 * The tool list already carries every tool's inputSchema, so the arguments are a
 * generated form rather than an empty `{}` the caller has to fill from
 * memory. The JSON view stays as the escape hatch — for a server that
 * under-declares its schema, and for pasting a call from somewhere else — and
 * both views edit the SAME argument object, so they cannot drift apart.
 */
function RunBody(React: ReactLike, kit: Kit, t: T, name: string, ArgView: (props: never) => unknown) {
  const [tools, setTools] = React.useState<Array<{ name: string; description?: string; inputSchema?: unknown }>>([])
  const [tool, setTool] = React.useState('')
  const [text, setText] = React.useState('{}')
  const [mode, setMode] = React.useState<'form' | 'json'>('form')
  const [out, setOut] = React.useState('')
  const [err, setErr] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  // --- past runs ------------------------------------------------------------
  const [histOpen, setHistOpen] = React.useState(false)
  const [q, setQ] = React.useState('')
  const [hist, setHist] = React.useState<ToolRun[] | undefined>(undefined)
  const [histFull, setHistFull] = React.useState('')
  /**
   * The in-flight search: a debounce timer and the id of the newest request.
   * A mutable box rather than state, because neither is anything to render -
   * re-rendering the form on every keystroke is what would take the caret out
   * of the box being typed in.
   */
  const [pending] = React.useState(() => ({ timer: undefined as ReturnType<typeof setTimeout> | undefined, id: 0 }))
  React.useEffect(() => {
    void api.mcp(name, 'tools').then((page) => {
      const list = (page.tools as Array<{ name: string; description?: string; inputSchema?: unknown }>) ?? []
      setTools(list)
      if (list.length > 0 && list[0] !== undefined) setTool(list[0].name)
    }).catch((error) => setErr((error as { message?: string }).message ?? String(error)))
  }, [])
  /**
   * Ask the SERVER for a tool's past runs. The filter runs there on purpose: it
   * matches the FULL stored arguments, while a row here shows only the engine's
   * 96-character preview - a keyword deeper in the payload must still find its
   * run. Replies are guarded by id, so one that lost the race to a newer query
   * cannot narrow the list to something nobody asked for.
   */
  const fetchHistory = (which: string, query: string) => {
    if (which === '') return
    pending.id += 1
    const id = pending.id
    void api.mcpToolHistory(name, which, query)
      .then((page) => { if (pending.id === id) setHist(page.entries) })
      .catch((error) => { if (pending.id === id) setErr((error as { message?: string }).message ?? String(error)) })
  }
  /** Switching tools starts a new call: the old tool's arguments do not apply. */
  const pickTool = (next: string) => {
    setTool(next); setText('{}'); setErr(''); setOut('')
    setHist(undefined); setHistFull(''); setQ('')
    if (histOpen) fetchHistory(next, '')
  }
  /** Typing narrows the list one scan per PAUSE in typing, not one per key. */
  const searchHistory = (query: string) => {
    setQ(query)
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    pending.id += 1 // whatever is in flight now answers the previous query
    pending.timer = setTimeout(() => { pending.timer = undefined; fetchHistory(tool, query) }, 200)
  }
  const toggleHistory = () => {
    if (histOpen) { setHistOpen(false); setHistFull(''); return }
    setHistOpen(true); setHist(undefined); setHistFull(''); fetchHistory(tool, q)
  }
  const current = tools.find((x) => x.name === tool)
  const histLabel = hist === undefined
    ? t('history')
    : hist.length === 0 && q === '' ? t('histNone') : t('histCount').replace('{n}', String(hist.length))
  const fields = argFieldsOf(current?.inputSchema)
  const args = parseArgs(text)
  const extra = args === undefined ? [] : undeclaredKeys(fields, args)
  const missing = args === undefined ? [] : missingRequired(fields, args)
  /** Fold one field edit back into the call. A bad number/JSON reports itself. */
  const commit = (field: ArgField, value: string | boolean) => {
    if (args === undefined) return
    setErr('')
    try { setText(JSON.stringify(applyArg(args, field, value), null, 2)) }
    catch (error) { setErr(error instanceof ArgError ? error.message : String(error)) }
  }
  /**
   * One past run in full. The row label is the engine's clipped preview, so the
   * complete arguments - and the reply they produced - are one seq lookup away.
   */
  const showRun = async (seq: number) => {
    setHistFull('\u2026')
    try {
      const r = await api.mcpCall(name, seq)
      const c = r.call as { args?: string; output?: string }
      setHistFull(t('argsForm') + '\n' + (c.args ?? '') + '\n\n' + t('histResult') + '\n' + prettyIfJson(unwrapJsonString(c.output ?? '')))
    } catch (error) { setHistFull((error as { message?: string }).message ?? String(error)) }
  }
  /**
   * Refill the form from a past run. Fetched by seq, never taken from the row:
   * the row carries a 96-character PREVIEW of the arguments, and writing that
   * into the form would replay a truncated call - or, when the preview was
   * quoted as a string the way it used to be, no call at all.
   */
  const reuse = async (seq: number) => {
    setErr('')
    try {
      const r = await api.mcpCall(name, seq)
      const raw = typeof (r.call as { args?: unknown }).args === 'string' ? (r.call as { args: string }).args : ''
      // Arguments past the engine's per-entry ceiling were stored with an
      // overflow marker, so they are no longer parseable JSON. Say that,
      // instead of failing as a syntax error.
      if (/more characters$/.test(raw)) { setErr(t('argsClipped')); return }
      const parsed: unknown = JSON.parse(raw === '' ? '{}' : raw)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) { setErr(t('argsNotObject')); return }
      setText(JSON.stringify(parsed, null, 2))
      setOut(''); setHistFull(''); setHistOpen(false)
    } catch (error) { setErr((error as { message?: string }).message ?? String(error)) }
  }
  const run = React.useCallback(async () => {
    const parsed = parseArgs(text)
    if (parsed === undefined) { setErr(t('argsNotObject')); return }
    setBusy(true); setOut(''); setErr('')
    try {
      const result = await api.mcpPost(name, 'call', { tool, arguments: parsed })
      setOut(replyText(result))
      // The run just landed in the log; if the list is open it must show it.
      if (histOpen) fetchHistory(tool, q)
    } catch (error) { setOut((error as { message?: string }).message ?? String(error)) }
    finally { setBusy(false) }
  }, [tool, text, histOpen, q])
  return kit.card(
    kit.h('div', { className: 'mmc-row' },
      kit.select({ value: tool, onChange: (e: { target: { value: string } }) => pickTool(e.target.value) },
        tools.map((x) => kit.h('option', { key: x.name, value: x.name }, x.name))),
      kit.actions(
        // Past runs of this tool: the fastest answer to "what did I pass last
        // time?" without retyping an argument object. Once loaded the label
        // carries the count, so the closed control says what is behind it.
        kit.btn(histLabel, () => { toggleHistory() }, { key: 'history', disabled: tool === '' }),
        kit.btn(t('runIt'), () => { void run() }, { key: 'run', primary: true, disabled: busy || tool === '' }),
      ),
    ),
    histOpen
      ? kit.h('div', { className: 'mmc-section' },
          kit.input({
            type: 'search', value: q, placeholder: t('histSearch'), 'aria-label': t('histSearch'),
            spellCheck: false, autoComplete: 'off',
            onChange: (e: { target: { value: string } }) => searchHistory(e.target.value),
          }),
          hist === undefined ? kit.note('\u2026') : null,
          hist !== undefined && hist.length === 0 ? kit.empty(q === '' ? t('histEmpty') : t('histNoMatch')) : null,
          hist !== undefined && hist.length > 0
            ? kit.rows(...hist.map((h) => kit.row({
                key: String(h.seq),
                state: h.ok === false ? 'bad' : 'ok',
                // What identifies a past run is the arguments it ran with; the
                // engine already collapsed identical argument sets to one row.
                name: h.args === '' ? t('noArgs') : h.args,
                meta: kit.factsOf(shortTime(h.at), h.client ?? h.via, h.ms !== undefined ? String(h.ms) + 'ms' : ''),
                onOpen: () => { void showRun(h.seq) },
                action: { label: t('reuse'), onPick: () => { void reuse(h.seq) } },
              })))
            : null,
          histFull !== '' ? kit.mono(histFull) : null,
        )
      : null,
    current?.description !== undefined && current.description !== '' ? kit.note(current.description) : null,
    tools.length > 0 && fields.length === 0 && args !== undefined && Object.keys(args).length === 0 && mode === 'form'
      ? kit.note(t('noArgs'))
      : null,
    fields.length > 0 || mode === 'json'
      ? kit.tabs([{ key: 'form', label: t('argsForm') }, { key: 'json', label: t('argsJson') }], mode, (key) => setMode(key as 'form' | 'json'))
      : null,
    mode === 'form' && args === undefined ? kit.error(t('argsNotObject')) : null,
    mode === 'form' && args !== undefined && fields.length > 0
      ? kit.h('div', { className: 'mmc-fields' },
          fields.map((field) => kit.h(ArgView, {
            key: tool + ':' + field.k,
            field, value: argValue(args, field),
            onCommit: (value: string | boolean) => commit(field, value),
          } as never)))
      : null,
    mode === 'form' && extra.length > 0 ? kit.note(t('argsExtra').replace('{n}', String(extra.length)) + ' (' + extra.join(', ') + ')') : null,
    mode === 'json'
      ? kit.textarea({ value: text, onChange: (e: { target: { value: string } }) => setText(e.target.value), spellCheck: false })
      : null,
    missing.length > 0 ? kit.note(t('argsMissing').replace('{k}', missing.join(', '))) : null,
    err !== '' ? kit.error(err) : null,
    out !== '' ? kit.mono(out) : null,
  )
}

/** Calls tab: paged tool-call log + full single call (bridge route pending backend wiring). */
function CallsBody(React: ReactLike, kit: Kit, t: T, name: string) {
  const [page, setPage] = React.useState(0)
  /**
   * Which log is being read. An entry has more than one: its own — the HTTP
   * endpoint and this panel's Run tab — plus one per session instance a DSH
   * agent's calls were recorded under. They stay separate because each file
   * numbers its calls from 1, and that number is how a call is opened.
   */
  const [sources, setSources] = React.useState<CallSource[] | undefined>(undefined)
  const [source, setSource] = React.useState('')
  // The engine's own page type. Restating its fields inline here is what let
  // the row renderer drift onto names the engine never sends.
  const [data, setData] = React.useState<CallsPage | undefined>(undefined)
  const [err, setErr] = React.useState('')
  // The expanded call: the RECORD, not a rendered string — the layout is the
  // renderer's business. `fullErr` is separate so a failed fetch does not
  // masquerade as a reply.
  const [full, setFull] = React.useState<Record<string, unknown> | undefined>(undefined)
  const [fullErr, setFullErr] = React.useState('')
  const which = source === '' ? name : source
  const load = React.useCallback(async (from: string, p: number) => {
    setErr(''); setData(undefined)
    try { setData(await api.mcpCalls(from, p)) } catch (error) { setErr((error as { message?: string }).message ?? String(error)) }
  }, [])
  // Paging reloads; `which` is deliberately NOT a dependency, because picking
  // a source loads it directly (below) — listing it here as well would fetch
  // the same page twice on every switch.
  React.useEffect(() => { void load(which, page) }, [load, page])
  React.useEffect(() => {
    void api.mcpCallSources(name)
      .then((r) => setSources(r.sources))
      // An older backend has no such route; one log is then all there is.
      .catch(() => setSources([]))
  }, [name])
  const pickSource = (next: string) => {
    setSource(next); setFull(undefined); setFullErr('')
    // Already on the first page: nothing else will trigger the read, so do it.
    // Otherwise going back to page 0 is what fires the effect above.
    if (page === 0) void load(next === '' ? name : next, 0)
    else setPage(0)
  }
  const expand = async (seq: number) => {
    setFull(undefined); setFullErr('')
    try { const r = await api.mcpCall(which, seq); setFull(r.call as Record<string, unknown>) }
    catch (error) { setFullErr((error as { message?: string }).message ?? String(error)) }
  }
  /** Drop the log being READ — the entry's own, or the one session's. */
  const clear = async () => {
    if (!confirm(t('confirmClearCalls').replace('{m}', which))) return
    setFull(undefined); setFullErr('')
    try { await api.mcpClearCalls(which); await load(which, page) } catch (error) { setErr((error as { message?: string }).message ?? String(error)) }
  }
  /** A session log is named for its hashes; six characters identify it. */
  const sourceLabel = (x: CallSource): string => {
    if (!x.session) return t('sourceEntry')
    const parts = parseSessionInstance(x.name)
    return t('sourceSession') + (parts === undefined ? '' : ' · ' + parts.workspaceKey.slice(0, 6))
  }
  return kit.card(
    // Only when there IS a choice: one log needs no chooser.
    sources !== undefined && sources.length > 1
      ? kit.h('div', { className: 'mmc-row' },
          sources.map((x) => kit.btn(
            sourceLabel(x) + (x.lastAt !== undefined ? ' · ' + shortTime(x.lastAt) : ''),
            () => { pickSource(x.session ? x.name : '') },
            { key: x.name, title: x.name, disabled: x.name === which },
          )))
      : null,
    sources !== undefined && sources.length > 1 ? kit.note(t('sourcesHint')) : null,
    err !== '' ? kit.error(isNoRoute({ message: err }) ? t('bridgePending') : t('loadFailed') + ': ' + err) : null,
    data === undefined && err === '' ? kit.note('…') : null,
    data !== undefined && data.calls.length === 0 ? kit.empty(t('empty')) : null,
    data !== undefined && data.calls.length > 0
      ? kit.h('div', { className: 'mmc-section' },
        kit.rows(...data.calls.map((c) => kit.row({
          key: String(c.seq),
          state: c.ok === false ? 'bad' : 'ok',
          name: c.tool,
          // `via` says WHO called: a client on the HTTP endpoint, or this
          // panel's own Run tab. That distinction is the reason to look.
          badge: c.via !== undefined && c.via !== '' ? { text: c.via } : undefined,
          meta: kit.factsOf(
            shortTime(c.at),
            c.client ?? '',
            c.ms !== undefined ? String(c.ms) + 'ms' : '',
            // `output` is the reply. `preview` is the BOOLEAN that says the
            // reply was clipped — reading it as the text is what crashed the
            // whole settings section.
            replyPreview(c.output),
            c.preview === true && c.chars !== undefined ? '+' + String(c.chars) + ' chars' : '',
          ),
          onOpen: () => { void expand(c.seq) },
        }))),
        // The call log is a TAIL: the engine answers "is there more behind
        // this page", never a count, so the pager says which page it is on
        // and stops at the end instead of inventing a total.
        kit.h('div', { className: 'mmc-row' },
          kit.btn('\u2039', () => { setPage(Math.max(0, page - 1)) }, { key: 'prev', title: t('prevPage'), disabled: page === 0 }),
          kit.tag(t('pageN').replace('{n}', String(page + 1))),
          kit.btn('\u203a', () => { setPage(page + 1) }, { key: 'next', title: t('nextPage'), disabled: data.more !== true }),
          kit.actions(kit.btn(t('clear'), () => { void clear() }, { key: 'clear', danger: true })),
        ),
      )
      : null,
    fullErr !== '' ? kit.error(fullErr) : null,
    full !== undefined ? CallDetail(kit, t, full) : null,
    StderrBody(kit, t, data),
  )
}

/**
 * What the spawned child wrote to stderr.
 *
 * The engine has captured this all along (a byte-bounded ring buffer per
 * child, Adapter.logs()) and hands it back with every page of the call log —
 * it was the panel that had nowhere to put it, so a server that died on
 * startup said its piece into a view nobody could open. It lives under the
 * calls list because that is one question: "what has this MCP been doing".
 */
function StderrBody(kit: Kit, t: T, data: CallsPage | undefined) {
  if (data === undefined) return null
  const text = typeof data.stderr === 'string' ? data.stderr : ''
  // Only a spawned child HAS a stderr; an http remote or an in-process adapter
  // has nothing to show and gets no empty box promising otherwise.
  if (text === '' && data.type !== 'proc') return null
  const blank = data.lifecycle === 'idle' ? t('logsIdle')
    : data.lifecycle === 'error' ? t('logsDied')
      : t('logsQuiet')
  return kit.h('div', { className: 'mmc-section' },
    kit.h('div', { className: 'mmc-label' }, t('logsStderr')),
    text === '' ? kit.note(blank) : kit.mono(text),
  )
}

/**
 * Bulk import: paste what another client already has (Claude Desktop, Cursor,
 * any .mcp.json, or a native catalog) and put the whole map on ONE layer.
 * Planning is a dry run — the rows below are what WOULD be written, with the
 * names the importer had to reallocate, so nothing is committed by surprise.
 */
function ImportBody(
  React: ReactLike, kit: Kit, t: T,
  targets: LayerId[], scope: ScopeIds | undefined,
  onDone: () => void, onCancel: () => void,
) {
  const [layerId, setLayerId] = React.useState(targets.length > 0 ? String(targets[0]) : '')
  const [text, setText] = React.useState('')
  const [plan, setPlan] = React.useState<ImportPreview | undefined>(undefined)
  const [result, setResult] = React.useState<ImportResult | undefined>(undefined)
  const [err, setErr] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const run = async (apply: boolean) => {
    setBusy(true); setErr('')
    try {
      if (apply) {
        setResult(await api.importApply(layerId, text, scope))
        setPlan(undefined)
        onDone()
      } else {
        setResult(undefined)
        setPlan(await api.importPlan(layerId, text, scope))
      }
    } catch (error) { setErr((error as { message?: string }).message ?? String(error)) }
    finally { setBusy(false) }
  }
  const planRow = (key: string, name: string, state: 'ok' | 'off' | 'bad', meta: string, badge?: string) =>
    kit.row({ key, state, name: name === '' ? '—' : name, meta, badge: badge !== undefined ? { text: badge } : undefined })
  return kit.card(
    kit.h('div', { className: 'mmc-label' }, t('importTitle')),
    kit.note(t('importHint')),
    kit.h('div', { className: 'mmc-row' },
      kit.select({ value: layerId, onChange: (e: { target: { value: string } }) => setLayerId(e.target.value), title: t('wizardWhere') },
        targets.map((id) => kit.h('option', { key: id, value: id }, id))),
      kit.actions(
        kit.btn(t('importPlan'), () => { void run(false) }, { key: 'plan', disabled: busy || text.trim() === '' || layerId === '' }),
        kit.btn(t('importApply'), () => { void run(true) }, { key: 'apply', primary: true, disabled: busy || plan === undefined || plan.add.length === 0 }),
        kit.btn(t('cancel'), onCancel, { key: 'cancel' }),
      ),
    ),
    kit.textarea({ value: text, onChange: (e: { target: { value: string } }) => setText(e.target.value), spellCheck: false, placeholder: t('importPlaceholder') }),
    err !== '' ? kit.error(err) : null,
    plan !== undefined && plan.add.length === 0 && plan.skip.length === 0 ? kit.empty(t('importNothing')) : null,
    plan !== undefined && (plan.add.length > 0 || plan.skip.length > 0)
      ? kit.rows(
          ...plan.add.map((r) => planRow('a-' + r.name, r.name, 'ok', '', t('importWillAdd'))),
          ...plan.skip.map((s, i) => planRow('s-' + String(i), s.name, 'off', s.reason)),
        )
      : null,
    result !== undefined ? kit.note(t('importDone').replace('{n}', String(result.added.length))) : null,
    result !== undefined
      ? kit.rows(
          ...result.added.map((n) => planRow('d-' + n, n, 'ok', '', t('importAdded'))),
          ...result.failed.map((f) => planRow('f-' + f.name, f.name, 'bad', f.error)),
          ...result.skip.map((s, i) => planRow('rs-' + String(i), s.name, 'off', s.reason)),
        )
      : null,
  )
}

/** The full workbench factory: returns a STABLE component for the settings pane. */
export function makeMcpWorkbench(React: ReactLike, kit: Kit): (props: { t: T }) => unknown {
  // One stable identity per hook-using conditional subtree (created ONCE per binding).
  const EditorView = makeEntryEditor(React, kit)
  const DetailView = makeMcpDetail(React, kit)
  const WhereView = view<{ t: T; targets: LayerId[]; onPick: (layerId: LayerId) => void; onCancel: () => void }>(
    React, (props) => WherePicker(kit, props.t, props.targets, props.onPick, props.onCancel))
  const ImportView = view<{ t: T; targets: LayerId[]; scope?: ScopeIds; onDone: () => void; onCancel: () => void }>(
    React, (props) => ImportBody(React, kit, props.t, props.targets, props.scope, props.onDone, props.onCancel))

  function McpWorkbench(props: { t: T }) {
    const t = props.t
    const [ws, setWs] = React.useState('')
    const [load, setLoad] = React.useState<Load>({ busy: true })
    const [engine, setEngine] = React.useState<Record<string, unknown> | undefined>(undefined)
    const [editor, setEditor] = React.useState<EditorArgs | undefined>(undefined)
    const [picking, setPicking] = React.useState(false)
    const [importing, setImporting] = React.useState(false)
    const [detail, setDetail] = React.useState('')
    const [workspaces, setWorkspaces] = React.useState<WorkspaceItem[] | undefined>(undefined)
    const [meta, setMeta] = React.useState<ViewMeta>({ version: 1, entries: {}, groups: [] })
    const [arranging, setArranging] = React.useState(false)
    const refresh = React.useCallback(async () => {
      setLoad({ busy: true })
      try {
        const scope = ws !== '' ? { ws } : undefined
        const [preview, eng] = await Promise.all([api.preview(scope), api.engine()])
        setLoad({ preview, busy: false })
        setEngine(eng)
      } catch (error) {
        setLoad({ busy: false, error: (error as { message?: string }).message ?? String(error) })
      }
      // The workspace picker is best-effort: an older bridge without the
      // route keeps the free-text fallback below.
      try { setWorkspaces((await api.workspaces()).items) } catch { setWorkspaces([]) }
      // Same for view metadata: an older bridge just means no grouping.
      try { setMeta(await api.view(ws !== '' ? { ws } : undefined)) } catch { /* ungrouped is a fine default */ }
    }, [ws])
    React.useEffect(() => { void refresh() }, [refresh])

    const editorCallbacks = {
      onCancel: () => setEditor(undefined),
      onSaved: () => { setEditor(undefined); void refresh() },
      onRevision: (revision: string) => setEditor((cur) => cur === undefined ? cur : { ...cur, revision }),
    }

    /** Open the editor on an EXISTING entry: capture its layer + revision (R5). */
    const editEntry = (entry: PreviewEntry) => {
      const captured = captureFromEntry(entry)
      setEditor({
        t, mode: 'edit', name: entry.name,
        initial: JSON.stringify(entry.def, null, 2),
        ...(captured.layerId !== undefined ? { layerId: captured.layerId } : {}),
        level: captured.level, source: captured.source, revision: captured.revision,
        ws: ws !== '' ? ws : undefined,
        ...editorCallbacks,
      })
    }
    const createOn = (layerId: LayerId) => {
      const layer = findLayer(load.preview, layerId)
      if (layer === undefined) return
      const captured = captureFromLayer(layer)
      setEditor({
        t, mode: 'create', name: '',
        // A blank definition of the layer's default type. The editor opens on
        // the FORM, so what a new entry needs is a starting shape, not a
        // hand-written literal the user has to recognise and overwrite.
        initial: JSON.stringify(blankDef(typesFor(captured.layerId)[0]!), null, 2),
        ...(captured.layerId !== undefined ? { layerId: captured.layerId } : {}),
        level: captured.level, source: captured.source, revision: captured.revision,
        ws: ws !== '' ? ws : undefined,
        ...editorCallbacks,
      })
    }
    const toggle = async (entry: PreviewEntry) => {
      const layerId = layerIdOfEntry(entry)
      try {
        await api.setEnabled(
          { ...(layerId !== undefined ? { layerId } : {}), level: entry.level, name: entry.name, enabled: entry.disabled, expectedRevision: entry.revision },
          ws !== '' ? { ws } : undefined,
        )
        await refresh()
      } catch (error) { setLoad({ ...load, error: (error as { message?: string }).message ?? String(error) }) }
    }
    /** Delete the entry's own mention on the layer it was read from (= re-inherit below). */
    const del = async (entry: PreviewEntry) => {
      if (!confirm(t('confirmDelete'))) return
      const captured = captureFromEntry(entry)
      try {
        await api.saveEntry(buildSaveBody(captured, entry.name, null), ws !== '' ? { ws } : undefined)
        await refresh()
      } catch (error) { setLoad({ ...load, error: (error as { message?: string }).message ?? String(error) }) }
    }
    /**
     * One entry row. The chips carry the neutral tones on purpose: living on
     * a native layer, being inherited or being disabled are ordinary facts,
     * and painting them in the error colour (as this row used to) made every
     * healthy list look like a failure report. The four actions ride in ONE
     * kit.actions group so they right-align identically on every row instead
     * of drifting with the chip width — and so the last one can no longer be
     * pushed past the pane edge and clipped.
     */
    /** Panel-only grouping/order. Never touches a config layer. */
    const arrange = async (name: string, change: { group?: string | null; move?: 'up' | 'down' }) => {
      try { setMeta(await api.viewSet({ name, ...change }, ws !== '' ? { ws } : undefined)) }
      catch (error) { setLoad({ ...load, error: (error as { message?: string }).message ?? String(error) }) }
    }
    const setGroup = (name: string) => {
      const current = meta.entries[name]?.group ?? ''
      const next = prompt(t('groupPrompt'), current)
      if (next === null) return
      void arrange(name, { group: next.trim() === '' ? null : next.trim() })
    }

    const entryRow = (entry: PreviewEntry) => {
      const layerId = layerIdOfEntry(entry)
      const group = meta.entries[entry.name]?.group
      const open = detail === entry.name
      // The row now carries IDENTITY only: what this is, where it lives,
      // whether it is on. Everything that used to ride here as a chip or a
      // button — inherited/pending/overrides, detail, edit, delete — became
      // one line of muted text or moved into the panel the row opens. Four
      // buttons and up to four chips per row is HOW this list ran out of
      // width; wrapping stopped the clipping, it did not remove the cause.
      const facts = [
        layerId !== undefined ? layerId : entry.level + '/' + entry.source,
        entry.inherited ? t('inherited') : '',
        entry.pending === true ? t('pendingHint') : '',
        entry.disabled ? t('disabled') : '',
        entry.overrides.length > 0 ? '↑' + String(entry.overrides.length) : '',
      ].filter((x) => x !== '')
      return kit.row({
        key: entry.name + entry.level + entry.source,
        state: entry.disabled ? 'off' : 'ok',
        // The kind leads the row as a tinted tile: redis red, Postgres blue,
        // Mongo green. A grey "mysql" chip had to be read before it could be
        // recognised.
        icon: typeOfDef(entry.def as unknown as Record<string, unknown>, layerId),
        name: entry.name,
        meta: facts.join(' · '),
        // The name and the chevron ARE the disclosure control: one target,
        // and the row needs no Detail button to say it can be opened.
        open,
        onOpen: () => setDetail(open ? '' : entry.name),
        // One switch says what the state IS and changes it. "Enable"/"Disable"
        // named the action, leaving the state to be inferred from the label.
        toggle: { on: !entry.disabled, label: t('switchFor').replace('{n}', entry.name), onChange: () => { void toggle(entry) } },
        menuLabel: t('moreFor').replace('{n}', entry.name),
        menu: arranging
          ? [
              { label: t('moveUp'), onPick: () => { void arrange(entry.name, { move: 'up' }) } },
              { label: t('moveDown'), onPick: () => { void arrange(entry.name, { move: 'down' }) } },
              { label: group !== undefined ? group : t('groupSet'), onPick: () => setGroup(entry.name) },
            ]
          : [
              { label: t('edit'), onPick: () => editEntry(entry) },
              { label: t('delete'), danger: true, onPick: () => { void del(entry) } },
            ],
      })
    }

    if (load.busy && load.preview === undefined) return kit.note('…')
    if (load.error !== undefined && load.preview === undefined) {
      return kit.card(kit.error(t('loadFailed') + ': ' + load.error), kit.btn(t('retry'), () => { void refresh() }))
    }
    const p = load.preview!
    return kit.h('div', { className: 'mmc-root' },
      // ONE primary action stays visible; refresh / arrange / import are
      // occasional, so they sit in the ⋯ menu. Four buttons plus the scope
      // picker did not fit a 564px pane and wrapped onto a second line.
      kit.head(t('intro'),
        kit.menu([
          { label: t('refresh'), onPick: () => { void refresh() } },
          { label: arranging ? t('arrangeDone') : t('arrange'), onPick: () => { setArranging(!arranging) } },
          { label: t('importTitle'), onPick: () => { setImporting(!importing); setPicking(false) } },
        ], t('more')),
        kit.btn(t('addMcp'), () => { setPicking(!picking); setImporting(false) }, { key: 'add', primary: true }),
      ),
      kit.h('div', { className: 'mmc-row' },
        workspaces !== undefined && workspaces.length > 0
          ? kit.select({ value: ws, onChange: (e: { target: { value: string } }) => setWs(e.target.value), title: t('workspace') },
              [kit.h('option', { key: '', value: '' }, '— ' + t('scopeGlobal') + ' —')].concat(
                workspaces.map((w) => kit.h('option', { key: w.id, value: w.id }, w.title !== undefined && w.title !== '' ? w.title + ' (' + w.id + ')' : w.id))))
          : kit.input({ placeholder: t('workspace'), value: ws, onChange: (e: { target: { value: string } }) => setWs(e.target.value), spellCheck: false }),
        StatusStrip(kit, t, p, engine),
      ),
      p.problems.length > 0 ? kit.card(kit.error(p.problems.map((x) => x.message).join('\n'))) : null,
      p.conflicts.length > 0 ? kit.card(kit.error(t('conflicts') + ': ' + p.conflicts.map((c) => c.name).join(', ')), kit.note(t('conflictsHint'))) : null,
      load.error !== undefined ? kit.error(t('saveFailed') + ': ' + load.error) : null,
      picking
        ? kit.h(WhereView, {
            key: 'where', t, targets: createTargetsFor(p),
            onPick: (id: LayerId) => { setPicking(false); createOn(id) },
            onCancel: () => setPicking(false),
          })
        : null,
      importing
        ? kit.h(ImportView, {
            key: 'import', t, targets: createTargetsFor(p),
            scope: ws !== '' ? { ws } : undefined,
            onDone: () => { void refresh() },
            onCancel: () => setImporting(false),
          })
        : null,
      // A CREATE has no row to sit under, so it opens above the list. An
      // EDIT renders inline under its own row (below), for the same reason
      // the detail panel does: parked up here it lands off-screen whenever
      // the row being edited is scrolled down, which reads as "nothing
      // happened".
      editor !== undefined && editor.mode === 'create' ? kit.h(EditorView, { key: 'editor', args: editor }) : null,
      // The detail panel opens INSIDE the list, directly under the row it
      // belongs to. Parked above the list it appeared off-screen whenever the
      // clicked row was scrolled down, which read as "nothing happened".
      p.entries.length === 0
        ? kit.empty(t('noEntries'), kit.btn(t('addMcp'), () => { setPicking(true); setImporting(false) }, { primary: true }), kit.btn(t('importTitle'), () => { setImporting(true); setPicking(false) }))
        : null,
      p.entries.length === 0 ? null : kit.rows(
        // Grouped, then manually ordered, then by name. A group heading is
        // emitted whenever the bucket changes, so an ungrouped list renders
        // exactly as before.
        ...sortEntries(p.entries, meta.entries).map((entry, i, all) => {
          const group = meta.entries[entry.name]?.group
          const previous = i > 0 ? meta.entries[all[i - 1]!.name]?.group : undefined
          const heading = i === 0 || group !== previous
            ? kit.h('div', { key: 'g-' + String(group ?? ''), className: 'mmc-ghead' },
                group !== undefined ? group : t('ungrouped'))
            : null
          const editing = editor !== undefined && editor.mode === 'edit' && editor.name === entry.name
          const rows: unknown[] = [entryRow(entry)]
          if (editing) rows.push(kit.h(EditorView, { key: 'editor-' + entry.name, args: editor! }))
          else if (detail === entry.name) {
            rows.push(kit.h(DetailView, {
              key: 'detail-' + entry.name, t, name: entry.name,
              scope: ws !== '' ? { ws } : undefined, onClose: () => setDetail(''),
              // Edit and Delete live HERE now — in the panel, which has a
              // full row to itself, instead of in the list row that has to
              // fit them beside the name on a 600px settings pane.
              onEdit: () => editEntry(entry), onDelete: () => { void del(entry) },
            }))
          }
          // Only emit the heading slot when there is more than one bucket —
          // a flat list should not grow a decorative "ungrouped" header.
          return meta.groups.length > 0 ? [heading, ...rows] : rows
        }),
      ),
    )
  }

  return McpWorkbench
}

/** Where does a NEW entry go? (layerId-addressed targets only) */
function WherePicker(kit: Kit, t: T, targets: LayerId[], onPick: (layerId: LayerId) => void, onCancel: () => void) {
  if (targets.length === 0) return kit.card(kit.note(t('noTargets')), kit.btn(t('cancel'), onCancel))
  return kit.card(
    kit.h('div', { className: 'mmc-label' }, t('wizardWhere')),
    kit.rows(...targets.map((id) => kit.row({
      key: id,
      name: t(layerNameKeyOf(id)),
      badge: { text: id },
      onOpen: () => onPick(id),
    }))),
    kit.note(t('wizardHint')),
    kit.btn(t('cancel'), onCancel),
  )
}

function layerNameKeyOf(layerId: LayerId): string {
  if (layerId === 'global:standard') return 'layerGlobalStandard'
  if (layerId === 'project:root') return 'layerProjectRoot'
  if (layerId === 'project:agents') return 'layerProjectAgents'
  if (layerId === 'global:native') return 'layerGlobalNative'
  if (layerId === 'project:native') return 'layerProjectNative'
  if (layerId === 'session:overrides') return 'layerSessionOverrides'
  return 'layerOther'
}


/** What the detail panel needs. onEdit/onDelete are optional: the session tab shows the panel without owning the entry. */
export interface McpDetailProps {
  t: T
  name: string
  scope?: ScopeIds
  onClose: () => void
  onEdit?: () => void
  onDelete?: () => void
}

/** MCP detail with tabs: status/tools/resources/prompts/run/calls. */
export function makeMcpDetail(React: ReactLike, kit: Kit): (props: McpDetailProps) => unknown {
  // One identity per (React, kit) for the argument rows: they render
  // conditionally and in a list, and each one holds a draft.
  const ArgView = view<{ field: ArgField; value: string | boolean; onCommit: (value: string | boolean) => void }>(
    React, (props) => ArgRow(React, kit, props)) as (props: never) => unknown
  const RunView = view<{ t: T; name: string }>(React, (props) => RunBody(React, kit, props.t, props.name, ArgView))
  const CallsView = view<{ t: T; name: string }>(React, (props) => CallsBody(React, kit, props.t, props.name))
  return function McpDetail(props: McpDetailProps) {
    const t = props.t
    const [tab, setTab] = React.useState<'status' | 'tools' | 'resources' | 'prompts' | 'run' | 'calls'>('status')
    const [nonce, setNonce] = React.useState(0)
    /**
     * The engine instance this pane talks to. It starts as the catalog name
     * and becomes whatever `ensure` answers, because the engine hosts ONE
     * instance per definition: when a session already has this server up, the
     * reply names that instance and the pane joins it. Asking under the
     * catalog name regardless is what used to start a second copy of the same
     * stdio server — a whole second process tree, for a pane that only wanted
     * to read it. The header keeps showing `props.name`: the entry is what the
     * user opened, the instance is only where it lives.
     */
    const [instance, setInstance] = React.useState(props.name)
    const [data, setData] = React.useState<Record<string, unknown> | undefined>(undefined)
    const [err, setErr] = React.useState('')
    const [busy, setBusy] = React.useState('')
    const [opened, setOpened] = React.useState('')
    /** Fetch one resource's body and show it under the list. */
    const openResource = async (uri: string) => {
      setOpened(t('opening') + ' ' + uri)
      try {
        const out = await api.mcpResource(instance, uri)
        setOpened(uri + (out.mimeType !== undefined ? ' · ' + out.mimeType : '') + '\n\n' + String(out.text ?? ''))
      } catch (error) { setOpened(uri + '\n\n' + ((error as { message?: string }).message ?? String(error))) }
    }
    React.useEffect(() => {
      setErr(''); setData(undefined); setOpened('')
      void (async () => {
        try {
          // Ensure-on-demand: a config entry that the engine does not host yet
          // gets hosted here (converted + started) so every tab answers.
          const ensured = await api.mcpPost(props.name, 'ensure', {}, props.scope)
          // Address what the engine answered, from this fetch onward: state is
          // set for later handlers, `live` for the request already in flight.
          const answered = (ensured as { name?: unknown }).name
          const live = typeof answered === 'string' && answered !== '' ? answered : props.name
          setInstance(live)
          if (tab === 'status') setData(await api.mcp(live, 'status') as Record<string, unknown>)
          else if (tab !== 'run' && tab !== 'calls') setData(await api.mcp(live, tab) as Record<string, unknown>)
        } catch (error) { setErr((error as { message?: string }).message ?? String(error)) }
      })()
    }, [tab, nonce, props.name])
    /**
     * Flip ONE tool.
     *
     * Apply first, then fold the engine's answer into the list in place.
     * Bumping the reload nonce before the POST — which is what this did — was
     * two bugs at once: the reload re-read the list while the change was still
     * in flight, so it came back with the old value and the switch snapped
     * back; and nothing bumped it again once the POST landed, so the new state
     * never arrived. And the reload begins with ensure(), which for a stdio
     * server is a process spawn — seconds of an EMPTY pane for a switch flip,
     * which is what "it just hangs" looked like.
     */
    const toggleTool = async (tool: string, enabled: boolean) => {
      setTab('tools'); setErr('')
      try {
        const out = await api.mcpPost(instance, 'setToolEnabled', { tool, enabled: !enabled })
        const disabled = (out as { disabledTools?: unknown }).disabledTools
        if (Array.isArray(disabled)) {
          setData((cur) => {
            if (cur === undefined) return cur
            // Turning one back ON: its row existed only because `disabledTools`
            // named it, so leaving that list would take the row away again —
            // the same disappearing act, one switch later. Carry it into the
            // served list by name; the next load replaces it with the engine's
            // own entry, description and schema included.
            const served = (cur.tools as Array<{ name: string }> | undefined) ?? []
            const restored = !disabled.includes(tool) && !served.some((x) => x.name === tool)
            return { ...cur, disabledTools: disabled, ...(restored ? { tools: [...served, { name: tool }] } : {}) }
          })
        } else setNonce((n) => n + 1) // an older engine answers without the list
      } catch (error) { setErr((error as { message?: string }).message ?? String(error)) }
    }
    const toggleResources = async (enabled: boolean) => {
      setErr('')
      try {
        const out = await api.mcpPost(instance, 'setResourcesEnabled', { enabled: !enabled })
        const now = (out as { enabled?: unknown }).enabled
        if (typeof now === 'boolean') setData((cur) => cur === undefined ? cur : { ...cur, resourceEnabled: now })
        else setNonce((n) => n + 1)
      } catch (error) { setErr((error as { message?: string }).message ?? String(error)) }
    }
    /** Lifecycle control (start/stop/restart) on the engine instance. */
    const lifecycle = async (verb: 'start' | 'stop' | 'restart') => {
      setBusy(verb + ' …')
      try {
        await api.mcpPost(instance, verb, {}, props.scope)
        setNonce(nonce + 1)
        setBusy('')
      } catch (error) { setBusy((error as { message?: string }).message ?? String(error)) }
    }
    return kit.card(
      // Seven buttons used to ride this header. Lifecycle is not something
      // anyone does often enough to spend the whole width on, so it lives in
      // one ⋯ menu; closing the panel stays a single visible target.
      kit.h('div', { className: 'mmc-head' },
        kit.h('div', { className: 'mmc-label' }, props.name),
        busy !== '' ? kit.tag(busy, 'info') : null,
        kit.actions(
          kit.menu([
            { label: t('start'), onPick: () => { void lifecycle('start') } },
            { label: t('stop'), onPick: () => { void lifecycle('stop') } },
            { label: t('restart'), onPick: () => { void lifecycle('restart') } },
            { label: t('refresh'), onPick: () => { setData(undefined); setNonce(nonce + 1) } },
            ...(props.onEdit !== undefined ? [{ label: t('edit'), onPick: props.onEdit }] : []),
            ...(props.onDelete !== undefined ? [{ label: t('delete'), danger: true, onPick: props.onDelete }] : []),
          ], t('moreFor').replace('{n}', props.name)),
          kit.btn('×', props.onClose, { key: 'close', title: t('close'), plain: true }),
        ),
      ),
      kit.tabs([
        { key: 'status', label: t('detail') }, { key: 'tools', label: t('tools') }, { key: 'resources', label: t('resources') },
        { key: 'prompts', label: t('prompts') }, { key: 'run', label: t('run') }, { key: 'calls', label: t('calls') },
      ], tab, (k) => setTab(k as typeof tab)),
      err !== '' ? kit.error(err) : null,
      data === undefined && tab !== 'run' && tab !== 'calls' && err === '' ? kit.note('…') : null,
      tab === 'status' && data !== undefined ? StatusBody(kit, t, data) : null,
      tab === 'tools' && data !== undefined ? ToolsBody(kit, data, (tool, enabled) => { void toggleTool(tool, enabled) }) : null,
      tab === 'resources' && data !== undefined ? kit.card(
        kit.h('div', { className: 'mmc-row' },
          kit.btn(data.resourceEnabled === false ? t('enable') : t('disable'), () => { void toggleResources(data.resourceEnabled !== false) }),
          kit.note(t('resourcesToggleHint')),
        ),
        ListBody(kit, t, data, 'resources', (uri) => { void openResource(uri) }),
        opened !== '' ? kit.mono(opened) : null,
      ) : null,
      tab === 'prompts' && data !== undefined ? ListBody(kit, t, data, 'prompts') : null,
      tab === 'run' ? kit.h(RunView, { t, name: instance }) : null,
      tab === 'calls' ? kit.h(CallsView, { t, name: instance }) : null,
    )
  }
}

/**
 * Engine health + the persistence layers, as ONE muted strip.
 *
 * These were two separate bordered cards, each holding a single line — two
 * empty boxes stacked above the only thing on this page anyone came for. Both
 * are ambient status: they belong in the margin, not in a container that
 * competes with the list.
 */
function StatusStrip(kit: Kit, t: T, p: Preview, engine: Record<string, unknown> | undefined) {
  const off = engine === undefined || engine.off === true
  const port = engine?.port
  const count = Array.isArray(engine?.mcps) ? (engine.mcps as unknown[]).length : 0
  // The plugin engine talks over the private IPC pipe and binds no HTTP
  // listener, so its port is 0 — printing "HTTP port 0" states a number that
  // is always zero and means nothing. Show a port only when there IS one.
  const listening = typeof port === 'number' && port > 0
  return kit.h('div', { className: 'mmc-row mmc-strip' },
    kit.dot(off ? 'off' : 'ok'),
    // "MCPs 8" read as the number of CONFIGURED entries and sat above a list
    // of a different length. It is the count the engine currently HOSTS, so
    // it has to say so.
    kit.h('span', { className: 'mmc-meta' },
      off ? t('engineOff')
        : (listening ? t('enginePort') + ' ' + String(port) + ' · ' : '') + t('mcpsHosted').replace('{n}', String(count))),
    kit.h('span', { className: 'mmc-spacer' }),
    // Layer chips: only a PROBLEM is toned as an error. A layer that merely
    // has no file yet is muted, with a title spelling out what the ∅ means.
    p.layers.map((l) => {
      const id = l.layerId !== undefined ? l.layerId : l.level + '/' + l.source
      const tone = l.problem !== undefined ? 'warn' : l.exists ? 'off' : 'off'
      const title = l.problem !== undefined
        ? (typeof l.problem === 'string' ? l.problem : l.problem.message)
        : l.exists ? t(layerNameKeyOf(id as LayerId)) : t('layerMissing')
      return kit.tag(id + (l.exists ? '' : ' ∅'), tone, id, title)
    }),
  )
}