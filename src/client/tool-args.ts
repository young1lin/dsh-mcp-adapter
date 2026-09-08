/**
 * Argument fields generated from a tool's OWN inputSchema.
 *
 * The Run tab used to hand you a textarea containing `{}` and leave you to
 * remember the argument names, their types, and which of them were required.
 * Every MCP the engine hosts already answers `tools/list` with a JSON Schema
 * per tool (engine/adminapi.ts serves `page.items` verbatim, schemas
 * included), so the panel had the answer all along and simply threw it away.
 * The gateway panel this plugin absorbed generated real inputs from that
 * schema (local-mcp-gateway src/admin/js/run.js); this module is that
 * behaviour, typed, plus the parts it did not have.
 *
 * The rules it inherits, because they were right:
 *  - one input per declared property, in the schema's own order, labelled
 *    with its name, its kind, and a `*` when the schema requires it;
 *  - a constrained property (`enum`) renders as a dropdown rather than a free
 *    text box that shows the allowed values nowhere;
 *  - arrays are one value per line and each line is coerced to the DECLARED
 *    item type — a schema saying items are numbers and receiving ["1","2"] is
 *    rejected by any server that validates its input;
 *  - objects (and `sql`) get a textarea, everything else a single line.
 *
 * Two things it does differently, both because silence was the bug:
 *  - a number that does not parse, or an object that is not JSON, REPORTS
 *    itself instead of being dropped from the call. The gateway's reader
 *    skipped an unparseable number, so a typo silently sent a different call
 *    than the one on screen;
 *  - a `false` on a REQUIRED boolean is sent. The gateway only ever sent a
 *    boolean when it was true, which made a required `false` unexpressible.
 *    An optional boolean left off is still omitted rather than sent as false,
 *    so an untouched form stays an empty call object.
 *
 * Defaults declared by the schema are shown (as the placeholder) but never
 * pre-filled into the arguments: a value the panel invents is a value the
 * server can no longer default for itself, and the two are not always equal.
 *
 * The argument OBJECT is the single source of truth, exactly as the entry
 * editor keeps its definition text: fields read from it and write back into
 * it, so the JSON view and the form view cannot drift, and a key this schema
 * does not model (a stale history entry, a server that under-declares) is
 * carried through an edit instead of being silently dropped.
 *
 * No runtime imports, deliberately: the tests load this file as SOURCE, and
 * Node's type stripping does not rewrite a './x.js' specifier to a sibling
 * .ts file — a relative runtime import here does not merely fail, it aborts
 * the whole test module and takes every test after it with it.
 *
 * @module dsh-mcp-adapter/client/tool-args
 */

/** How one argument is edited. Mirrors the JSON Schema `type` it came from. */
export type ArgKind = 'string' | 'number' | 'boolean' | 'array' | 'object'

/** One editable argument of one tool. */
export interface ArgField {
  /** Property name; the key in the call's `arguments` object. */
  k: string
  kind: ArgKind
  /** Declared in the schema's `required` list. */
  required: boolean
  /** The schema's own `description`, shown under the input. */
  description?: string
  /** Allowed values (`enum`), rendered as a dropdown. */
  choices?: string[]
  /** Declared item type for an array, used to coerce each line. */
  items?: string
  /** Render as a textarea rather than a single line. */
  area: boolean
  /** Syntax hint shown in the empty input. */
  placeholder?: string
}

/**
 * A field whose current text could not be turned into a value.
 *
 * The key is assigned in the body rather than declared as a constructor
 * parameter property: this module is loaded as SOURCE by the tests, and
 * Node's strip-only type stripping rejects parameter properties outright
 * (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX) — which aborts the whole test module.
 */
export class ArgError extends Error {
  /** The argument this error belongs to. */
  key: string
  constructor(key: string, message: string) {
    super(message)
    this.name = 'ArgError'
    this.key = key
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** JSON Schema `type` (or the first named type of a union) as one of ours. */
function kindOf(prop: Record<string, unknown>): ArgKind {
  const raw = Array.isArray(prop.type)
    ? (prop.type as unknown[]).find((x) => typeof x === 'string' && x !== 'null')
    : prop.type
  const type = typeof raw === 'string' ? raw : ''
  if (type === 'array') return 'array'
  if (type === 'object') return 'object'
  if (type === 'boolean') return 'boolean'
  if (type === 'number' || type === 'integer') return 'number'
  return 'string'
}

/** Scalars a dropdown can round-trip; anything else stays a free-text box. */
function choicesOf(prop: Record<string, unknown>): string[] | undefined {
  if (!Array.isArray(prop.enum) || prop.enum.length === 0) return undefined
  const flat: string[] = []
  for (const value of prop.enum as unknown[]) {
    if (typeof value === 'string') flat.push(value)
    else if (typeof value === 'number' || typeof value === 'boolean') flat.push(String(value))
    else return undefined // an object/array enum is not a dropdown; edit it as text
  }
  return flat
}

function placeholderOf(key: string, kind: ArgKind, prop: Record<string, unknown>): string | undefined {
  if (prop.default !== undefined) {
    return typeof prop.default === 'string' ? prop.default : JSON.stringify(prop.default)
  }
  if (key === 'sql') return 'SELECT 1'
  if (kind === 'object') return '{ }'
  if (kind === 'array') {
    const items = asRecord(prop.items)
    const type = items !== undefined && typeof items.type === 'string' ? items.type : ''
    return type === '' ? 'one per line' : 'one per line (' + type + ')'
  }
  return undefined
}

/**
 * The fields one tool's schema declares.
 * @param inputSchema - the tool's `inputSchema`, whatever shape it arrived in.
 * @returns one field per declared property, in the schema's own order; empty
 *   when the tool declares no arguments (which is not the same as an unknown
 *   schema — both read as "no fields", and the caller says so either way).
 */
export function argFieldsOf(inputSchema: unknown): ArgField[] {
  const schema = asRecord(inputSchema)
  const props = schema === undefined ? undefined : asRecord(schema.properties)
  if (props === undefined) return []
  const required = new Set(
    Array.isArray(schema?.required) ? (schema.required as unknown[]).filter((x): x is string => typeof x === 'string') : [],
  )
  const fields: ArgField[] = []
  for (const key of Object.keys(props)) {
    const prop = asRecord(props[key]) ?? {}
    const kind = kindOf(prop)
    const items = asRecord(prop.items)
    const itemType = items !== undefined && typeof items.type === 'string' ? items.type : undefined
    const choices = choicesOf(prop)
    fields.push({
      k: key,
      kind,
      required: required.has(key),
      ...(typeof prop.description === 'string' && prop.description !== '' ? { description: prop.description } : {}),
      ...(choices !== undefined ? { choices } : {}),
      ...(kind === 'array' && itemType !== undefined ? { items: itemType } : {}),
      // A dropdown is one line whatever it holds; only free text grows.
      area: choices === undefined && (kind === 'array' || kind === 'object' || key === 'sql'),
      ...(() => { const ph = placeholderOf(key, kind, prop); return ph !== undefined ? { placeholder: ph } : {} })(),
    })
  }
  return fields
}

/**
 * One field's current value, as the input renders it.
 * @param args - the call's argument object.
 * @param field - the field to read.
 * @returns a boolean for a checkbox, otherwise the text to show.
 */
export function argValue(args: Record<string, unknown>, field: ArgField): string | boolean {
  const value = args[field.k]
  if (field.kind === 'boolean') return value === true
  if (value === undefined || value === null) return ''
  if (field.kind === 'array') {
    return Array.isArray(value) ? value.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join('\n') : String(value)
  }
  if (field.kind === 'object') {
    return typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)
  }
  return typeof value === 'string' ? value : String(value)
}

/** Coerce one array line to the item type the schema declared. */
function coerceItem(line: string, itemType: string | undefined): unknown {
  if (itemType === 'number' || itemType === 'integer') {
    const n = Number(line)
    return Number.isNaN(n) ? line : n
  }
  if (itemType === 'boolean') return line === 'true' ? true : line === 'false' ? false : line
  return line
}

/**
 * Fold one field edit back into the argument object.
 *
 * Blank clears the key rather than sending an empty string: "I left this out"
 * and "I sent an empty value" are different calls, and the form has no other
 * way to say the first one.
 * @param args - the current argument object; never mutated.
 * @param field - the field that changed.
 * @param value - its new input value.
 * @returns the new argument object.
 * @throws ArgError when the text cannot become the declared type.
 */
export function applyArg(args: Record<string, unknown>, field: ArgField, value: string | boolean): Record<string, unknown> {
  const next = { ...args }
  if (field.kind === 'boolean') {
    // Optional + false is an omission, so an untouched form stays `{}`.
    // Required + false is a real value the server asked for, so it is sent.
    if (value === true) next[field.k] = true
    else if (field.required) next[field.k] = false
    else delete next[field.k]
    return next
  }
  const raw = typeof value === 'string' ? value.trim() : String(value)
  if (raw === '') { delete next[field.k]; return next }
  if (field.kind === 'number') {
    const n = Number(raw)
    if (Number.isNaN(n)) throw new ArgError(field.k, field.k + ' is not a number')
    next[field.k] = n
    return next
  }
  if (field.kind === 'array') {
    next[field.k] = raw.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
      .map((line) => coerceItem(line, field.items))
    return next
  }
  if (field.kind === 'object') {
    try { next[field.k] = JSON.parse(raw) }
    catch { throw new ArgError(field.k, field.k + ' is not valid JSON') }
    return next
  }
  next[field.k] = typeof value === 'string' ? value : raw
  return next
}

/**
 * Required properties the call does not carry.
 * @param fields - the tool's fields.
 * @param args - the argument object about to be sent.
 * @returns the missing names, in schema order.
 */
export function missingRequired(fields: ArgField[], args: Record<string, unknown>): string[] {
  return fields.filter((f) => f.required && (args[f.k] === undefined || args[f.k] === ''))
    .map((f) => f.k)
}

/**
 * Keys present in the call that the schema does not declare.
 *
 * They are kept, not stripped — a reused history entry from before a schema
 * change, or a server that under-declares its own tool, is still a call the
 * user may want to send — but the panel says they exist rather than showing a
 * form that silently omits them.
 * @param fields - the tool's fields.
 * @param args - the argument object.
 * @returns the undeclared key names, sorted.
 */
export function undeclaredKeys(fields: ArgField[], args: Record<string, unknown>): string[] {
  const known = new Set(fields.map((f) => f.k))
  return Object.keys(args).filter((k) => !known.has(k)).sort()
}

/**
 * Parse the JSON view back into an argument object.
 * @param text - the textarea contents.
 * @returns the object, or undefined when it is not a JSON object.
 */
export function parseArgs(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return {}
  try { return asRecord(JSON.parse(trimmed)) } catch { return undefined }
}
