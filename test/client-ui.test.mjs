/**
 * UI tests for src/client (owned by the UI repair track):
 *  - scope.ts pure layer logic (R5 layerId vocabulary, save addressing,
 *    conflict detection, session classification);
 *  - api.ts typed surface (URLs, query scope ids, methods);
 *  - page behavior through a MINI React (per-instance hook bookkeeping that
 *    fails on hook-order changes exactly like real React) driving the REAL
 *    bundled client: R5 editor revision retention (no preview on save, 409
 *    keeps the draft), tab-switch hook safety, and the session tab's
 *    snapshot/current/pending split + override semantics.
 *
 * The pages are bundled with esbuild into a TEMP dir (never dist/) — if the
 * bundler cannot run in this environment the page tests skip loudly.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

globalThis.confirm = () => true

const here = fileURLToPath(new URL('.', import.meta.url))

// ---------------------------------------------------------------- scope.ts (pure)

const scope = await import('../src/client/scope.ts')

const layer = (over) => ({
  level: 'global', source: 'standard', label: 'HOST-ONLY-LABEL', exists: true, revision: 'r0', ...over,
})
const entry = (over) => ({
  name: 'x', level: 'global', source: 'standard', def: {}, inherited: false, overrides: [], disabled: false, revision: 'r0', ...over,
})

test('scope: layerId vocabulary — backend field wins, fallback derivable, project:agents only via backend', () => {
  assert.equal(scope.layerIdOfLayer(layer({ layerId: 'project:agents', level: 'project', source: 'standard' })), 'project:agents')
  assert.equal(scope.layerIdOfLayer(layer({ level: 'global', source: 'standard' })), 'global:standard')
  assert.equal(scope.layerIdOfLayer(layer({ level: 'project', source: 'standard' })), 'project:root')
  assert.equal(scope.layerIdOfLayer(layer({ level: 'global', source: 'native' })), 'global:native')
  assert.equal(scope.layerIdOfLayer(layer({ level: 'project', source: 'native' })), 'project:native')
  assert.equal(scope.layerIdOfLayer(layer({ level: 'session', source: 'session' })), 'session:overrides')
  assert.equal(scope.layerIdOfEntry(entry({ layerId: 'project:agents' })), 'project:agents')
  assert.equal(scope.layerIdOfEntry(entry({ source: 'session', level: 'session' })), 'session:overrides')
  // The two project standard files are indistinguishable in the fallback:
  assert.deepEqual(
    [scope.layerIdOfEntry(entry({ level: 'project', source: 'standard' })), scope.layerIdOfLayer(layer({ level: 'project', source: 'standard' }))],
    ['project:root', 'project:root'],
  )
})

test('scope: buildSaveBody carries the CAPTURED revision + layerId and never a label/path', () => {
  const body = scope.buildSaveBody({ layerId: 'global:standard', level: 'global', source: 'standard', revision: 'rev-OPEN' }, 'alpha', { command: 'b' })
  assert.equal(body.layerId, 'global:standard')
  assert.equal(body.expectedRevision, 'rev-OPEN')
  assert.equal(body.name, 'alpha')
  assert.deepEqual(body.def, { command: 'b' })
  for (const forbidden of ['label', 'path', 'source path']) assert.equal(body[forbidden], undefined)
  const legacy = scope.buildSaveBody({ level: 'project', source: 'standard', revision: '' }, 'beta', null)
  assert.equal(legacy.layerId, undefined)
  assert.equal(legacy.def, null)
})

test('scope: conflict detection and session classification', () => {
  assert.equal(scope.isConflictRejection({ code: 'CONFLICT' }), true)
  assert.equal(scope.isConflictRejection({ status: 409 }), true)
  assert.equal(scope.isConflictRejection({ status: 500, code: 'IO' }), false)
  const { pending, current } = scope.classifySessionEntries([
    entry({ name: 'beta' }),
    entry({ name: 'gamma', source: 'session', level: 'session', pending: true }),
    entry({ name: 'delta', disabled: true }),
  ])
  assert.deepEqual(pending.map((e) => e.name), ['gamma'])
  assert.deepEqual(current.map((e) => e.name).sort(), ['beta', 'delta'])
})

test('scope: createTargetsFor uses backend layerIds in canonical order and dedupes', () => {
  const preview = {
    layers: [
      layer({ layerId: 'global:standard' }),
      layer({ layerId: 'global:claude' }),
      layer({ layerId: 'project:claude', level: 'project', source: 'standard' }),
      layer({ layerId: 'project:claude', level: 'project', source: 'standard' }),
      layer({ layerId: 'global:native', level: 'global', source: 'native' }),
      layer({ layerId: 'project:agents', level: 'project', source: 'standard' }),
      layer({ layerId: 'project:root', level: 'project', source: 'standard' }),
      layer({ layerId: 'project:native', level: 'project', source: 'native' }),
      layer({ layerId: 'session:overrides', level: 'session', source: 'session' }),
    ],
    entries: [], conflicts: [], problems: [],
  }
  assert.deepEqual(scope.createTargetsFor(preview), ['global:standard', 'global:claude', 'project:root', 'project:agents', 'project:claude', 'global:native', 'project:native'])
  for (const layerId of ['global:claude', 'project:claude']) {
    const captured = scope.captureFromEntry(entry({ layerId, revision: 'claude-rev' }))
    assert.equal(scope.buildSaveBody(captured, 'x', { command: 'node' }).layerId, layerId)
    assert.equal(scope.buildSaveBody(captured, 'x', {}).expectedRevision, 'claude-rev')
    assert.ok(scope.LAYER_NAME_KEYS[layerId])
  }
  assert.deepEqual(scope.createTargetsFor(undefined), [])
  // pre-layerId backend: project falls back to root only
  const legacyPreview = { layers: [layer(), layer({ level: 'project', source: 'standard' }), layer({ level: 'global', source: 'native' })], entries: [], conflicts: [], problems: [] }
  assert.deepEqual(scope.createTargetsFor(legacyPreview), ['global:standard', 'project:root', 'global:native'])
})

// ---------------------------------------------------------------- api.ts (fetch stub)

const apiMod = await import('../src/client/api.ts')

function stubFetch(handler) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    const full = String(url)
    const call = { method: init?.method ?? 'GET', url: full.replace('/dsh-mcp-manager', ''), body: init?.body !== undefined ? JSON.parse(init.body) : undefined }
    calls.push(call)
    const answer = handler(call)
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      statusText: answer.status === 409 ? 'Conflict' : 'OK',
      json: async () => answer.json ?? {},
    }
  }
  return calls
}

test('api: scope ids and MCP calls use the expected bridge paths, without Advanced methods', async () => {
  const calls = stubFetch(() => ({ status: 200, json: {} }))
  await apiMod.api.preview({ ws: 'ws1', ss: 'sess-1' })
  assert.equal(calls[0].url, '/preview?ws=ws1&ss=sess-1')
  await apiMod.api.saveEntry({ level: 'session', source: 'session', name: 'n', def: null, expectedRevision: 'r' }, { ss: 'sess-1' })
  assert.equal(calls[1].url, '/entry?ss=sess-1')
  assert.equal(calls[1].method, 'POST')
  await apiMod.api.mcpCalls('alpha', 3)
  assert.equal(calls[2].url, '/mcp/alpha/calls?page=3')
  for (const method of ['tokens', 'tokenCreate', 'tokenSecret', 'tokenRotate', 'tokenRevoke', 'listener', 'listenerSave', 'memory']) {
    assert.equal(method in apiMod.api, false, method + ' is not exported to the client')
  }
  assert.equal(apiMod.isNoRoute({ message: 'no route for GET /missing' }), true)
  assert.equal(apiMod.isNoRoute({ message: 'other' }), false)
})

// ---------------------------------------------------------------- mini React + real pages

/** Minimal React-like runtime: per-instance hook ledgers; a hook-count
 * change on the SAME component instance throws exactly like React's
 * "Rendered more hooks than during the previous render". */
function makeMiniReact() {
  let current = null
  let rootEl = null
  let scheduled = false
  let renderError = null
  const instances = new Map()
  const afterRender = []

  function schedule() {
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => { scheduled = false; if (rootEl !== null) renderRoot() })
  }

  const useState = (initial) => {
    const inst = current
    const i = inst.index
    inst.index += 1
    if (!Object.hasOwn(inst.hooks, i)) inst.hooks[i] = { value: typeof initial === 'function' ? initial() : initial }
    const slot = inst.hooks[i]
    return [slot.value, (v) => { slot.value = typeof v === 'function' ? v(slot.value) : v; schedule() }]
  }
  const useEffect = (fn) => { current.pendingEffects.push(fn); current.index += 1 }
  const useCallback = (fn) => { current.index += 1; return fn }
  const createElement = (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } })

  const nameOf = (fn) => fn.displayName ?? fn.name ?? String(fn)

  function mount(el, parentKey, pos) {
    if (el === null || el === undefined || el === false || el === true) return { leaf: true }
    if (typeof el === 'string' || typeof el === 'number') return { leaf: true, text: String(el) }
    if (Array.isArray(el)) return { array: el.map((c, i) => mount(c, parentKey, i)) }
    if (typeof el.type === 'function') {
      const key = parentKey + '|' + pos + '|' + nameOf(el.type)
      let inst = instances.get(key)
      if (inst === undefined || inst.type !== el.type) {
        inst = { key, type: el.type, hooks: {}, index: 0, pendingEffects: [], ranEffects: false, hookSignature: null }
        instances.set(key, inst)
      }
      const prev = current
      current = inst
      inst.index = 0
      inst.pendingEffects = []
      let out
      try { out = el.type(el.props ?? {}) } finally { current = prev }
      if (inst.hookSignature === null) inst.hookSignature = inst.index
      else if (inst.hookSignature !== inst.index) {
        throw new Error('HOOK ORDER VIOLATION in ' + nameOf(el.type) + ': ' + inst.hookSignature + ' -> ' + inst.index)
      }
      const child = mount(out, inst.key, 0)
      const ranAlready = inst.ranEffects
      afterRender.push(() => { if (!ranAlready) { inst.ranEffects = true; for (const fn of inst.pendingEffects) fn() } })
      return { comp: inst, child }
    }
    const children = (el.props?.children ?? []).flat(Infinity)
    return { el, children: children.map((c, i) => mount(c, parentKey + '/' + (typeof el.type === 'string' ? el.type : '?') + pos, i)) }
  }

  function renderRoot() {
    if (rootEl === null) return
    afterRender.length = 0
    try {
      tree = mount(rootEl, '$', 0)
      for (const fn of afterRender.splice(0)) fn()
    } catch (error) {
      renderError = error
      throw error
    }
  }

  let tree = null
  const api = {
    createElement, useState, useEffect, useCallback,
    render(element) { rootEl = element; renderRoot() },
    tree: () => tree,
    renderError: () => renderError,
    nameOf,
  }
  return api
}

function findAll(node, pred, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node.array)) { for (const n of node.array) findAll(n, pred, out); return out }
  if (node.comp !== undefined) return findAll(node.child, pred, out)
  if (node.children !== undefined) { for (const c of node.children) findAll(c, pred, out) }
  if (node.el !== undefined && pred(node.el)) out.push(node)
  return out
}
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (node.text !== undefined) return node.text
  if (Array.isArray(node.array)) return node.array.map(textOf).join('')
  if (node.comp !== undefined) return textOf(node.child)
  if (node.children !== undefined) return node.children.map(textOf).join('')
  return ''
}
function wholeText(mini) {
  return findAll(mini.tree(), () => true).map(textOf).join(' ') + ' ' + textOf(mini.tree())
}
async function flush(rounds = 16) {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve))
}
function buttonsLabelled(node, label) {
  return findAll(node, (el) => el.type === 'button' && (el.props['aria-label'] === label || textOfEl(el) === label))
}
async function clickButton(mini, label) {
  const nodes = buttonsLabelled(mini.tree(), label)
  assert.ok(nodes.length > 0, 'no button labelled ' + label)
  nodes[0].el.props.onClick()
  await flush()
}
/** The list row whose rendered text contains `name`. */
function rowNamed(mini, name) {
  return findAll(mini.tree(), (el) => typeof el.props.className === 'string' && el.props.className.split(' ').includes('mmc-r'))
    .find((n) => textOf(n).includes(name))
}
/**
 * Open ONE row's ⋯ menu. Secondary actions moved off the row into this menu,
 * so a test that used to press a visible button now presses it one level in —
 * scoped to its row, because several menus can be open at once in this
 * harness (there is no document to close them).
 */
async function openRowMenu(mini, name) {
  const node = rowNamed(mini, name)
  assert.ok(node !== undefined, 'no row named ' + name)
  const more = within(node, 'mmc-more')[0]
  assert.ok(more !== undefined, 'row ' + name + ' has no ⋯ menu')
  more.el.props.onClick()
  await flush()
}
/**
 * Open the PAGE header's ⋯ menu. Refresh / arrange / import are occasional
 * actions: they moved off the header, which could not fit four buttons plus
 * the scope picker on a 564px pane.
 */
async function openPageMenu(mini) {
  const more = findAll(mini.tree(), (el) => el.props.className === 'mmc-more')[0]
  assert.ok(more !== undefined, 'the page header has no ⋯ menu')
  more.el.props.onClick()
  await flush()
}
/** Press a control that belongs to ONE row (its menu included). */
async function clickInRow(mini, name, label) {
  const node = rowNamed(mini, name)
  assert.ok(node !== undefined, 'no row named ' + name)
  const nodes = buttonsLabelled(node, label)
  assert.ok(nodes.length > 0, 'row ' + name + ' has no control labelled ' + label)
  nodes[0].el.props.onClick()
  await flush()
}
function textOfEl(el) {
  return (el.props.children ?? []).flat(Infinity).map((c) => typeof c === 'string' || typeof c === 'number' ? String(c) : '').join('')
}
function textareas(mini) { return findAll(mini.tree(), (el) => el.type === 'textarea') }
function findText(mini, needle) {
  return findAll(mini.tree(), () => true).some((n) => textOf(n).includes(needle)) || wholeText(mini).includes(needle)
}

// -------------------------------------------------------------------- page tests

async function bundleClient() {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-client-ui-'))
  const outfile = join(tmp, 'client-bundle.mjs')
  const esbuild = await import('esbuild')
  // Same injection as scripts/build-client.mjs: the bundle's registration id
  // is the package name (the dsh client-modules id contract).
  const name = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).name
  await esbuild.build({
    entryPoints: [join(here, '..', 'src', 'client', 'index.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    outfile,
    logLevel: 'silent',
    define: { CLIENT_MODULE_ID: JSON.stringify(name) },
  })
  return { tmp, url: 'file://' + outfile.replaceAll('\\', '/') }
}

const bundled = await bundleClient().catch((error) => ({ error }))
const bundleSkipped = bundled.error !== undefined
if (!bundleSkipped) process.on('exit', () => { try { rmSync(bundled.tmp, { recursive: true, force: true }) } catch { /* best effort */ } })

/** Load the real client through a fake __ModuleLoader__ and a mini React. */
async function loadClient(mini, ctxExtra = {}) {
  const registrations = []
  const disposers = []
  const captured = { spec: null }
  globalThis.window = { __ModuleLoader__: { load: (spec) => { captured.spec = spec } } }
  await import(bundled.url + '?nonce=' + String(Math.random()).slice(2))
  assert.ok(captured.spec !== null, 'loader spec captured')
  const mod = captured.spec.factory((id) => {
    if (id === 'react') return mini
    throw new Error('unexpected require: ' + id)
  })
  const ctx = {
    locale: { register: () => undefined, bind: () => (key) => key },
    slots: {
      inject: (slot, cb) => { registrations.push({ slot, ...cb() }) },
      register: (...args) => { registrations.push({ slot: args[0]?.name, options: args[0], component: args[1] }); return () => {} },
    },
    effect: (fn) => { disposers.push(fn()); return () => {} },
    get: (name) => ctxExtra[name],
    ...ctxExtra,
  }
  mod.apply(ctx)
  return { registrations }
}

test('pages: settings shows only MCP services without the Advanced tab', { skip: bundleSkipped }, async () => {
  const mini = makeMiniReact()
  stubFetch((call) => {
    if (call.url.startsWith('/preview')) return { status: 200, json: previewDoc() }
    if (call.url.startsWith('/engine')) return { status: 200, json: { off: true } }
    return { status: 500, json: { error: 'no route for ' + call.method + ' ' + call.url } }
  })
  const { registrations } = await loadClient(mini)
  const section = registrations.find((r) => r.slot === 'settings.section')
  assert.ok(section !== undefined, 'settings.section registered')
  mini.render(mini.createElement(section.component, { t: (key) => key }))
  await flush()
  assert.ok(findText(mini, 'entries'), 'MCP services heading remains visible')
  assert.ok(findText(mini, 'alpha'), 'MCP services still lists entries')
  assert.equal(mini.renderError(), null)
  assert.equal(findAll(mini.tree(), (el) => el.type === 'button' && textOfEl(el) === 'advanced').length, 0)
  assert.ok(!findText(mini, 'advancedIntro'), 'Advanced content is not rendered')
})

test('pages (R5): editor keeps the OPEN revision, never previews on save, and a 409 keeps the draft', { skip: bundleSkipped }, async () => {
  const mini = makeMiniReact()
  let doc = previewDoc()
  let entryStatus = 409
  const calls = stubFetch((call) => {
    if (call.url.startsWith('/preview')) return { status: 200, json: doc }
    if (call.url.startsWith('/engine')) return { status: 200, json: { off: true } }
    if (call.url.startsWith('/entry')) return { status: entryStatus, json: entryStatus === 409 ? { error: 'changed since read', code: 'CONFLICT' } : { revision: 'rev-new' } }
    return { status: 500, json: { error: 'no route' } }
  })
  const { registrations } = await loadClient(mini)
  const section = registrations.find((r) => r.slot === 'settings.section')
  mini.render(mini.createElement(section.component, { t: (key) => key }))
  await flush()
  await clickButton(mini, 'alpha')           // the row's name IS the disclosure control
  await openRowMenu(mini, 'alpha')           // Edit is a secondary action: it lives in the row's ⋯
  await clickInRow(mini, 'alpha', 'edit')
  await clickButton(mini, 'jsonTab')         // raw JSON is one view over the same draft
  const area = textareas(mini)[0]
  assert.ok(area.el.props.value.includes('node a.js'), 'editor shows the entry def')
  const previewCallsAtOpen = calls.filter((c) => c.url.startsWith('/preview')).length
  area.el.props.onChange({ target: { value: '{"command":"node b.js"}' } })
  await flush()
  doc = previewDoc('rev-mid-0002')           // the file changes WHILE editing
  await clickButton(mini, 'save')
  // The save call itself:
  const saves = calls.filter((c) => c.url.startsWith('/entry'))
  assert.equal(saves.length, 1, 'exactly one save request')
  assert.deepEqual(
    saves[0].body,
    { layerId: 'global:standard', level: 'global', source: 'standard', name: 'alpha', def: { command: 'node b.js' }, expectedRevision: 'rev-open-0001' },
    'save addressed by the OPEN layerId+revision',
  )
  // No preview re-read between open and save:
  assert.equal(calls.filter((c) => c.url.startsWith('/preview')).length, previewCallsAtOpen, 'no preview fetch during edit/save')
  // 409 keeps the draft and shows the conflict affordance:
  assert.ok(findText(mini, 'conflict'), 'conflict surfaced')
  assert.ok(textareas(mini)[0].el.props.value.includes('node b.js'), 'draft kept after conflict')
  await clickButton(mini, 'reloadLayerKeepDraft')   // explicit reload picks up the new revision
  assert.ok(calls.filter((c) => c.url.startsWith('/preview')).length > previewCallsAtOpen, 'reload re-read the preview')
  entryStatus = 200
  await clickButton(mini, 'save')
  const saves2 = calls.filter((c) => c.url.startsWith('/entry'))
  assert.equal(saves2.length, 2)
  assert.equal(saves2[1].body.expectedRevision, 'rev-mid-0002', 'retry saves against the reloaded revision')
  assert.equal(textareas(mini).length, 0, 'editor closed after success')
})

test('pages: session tab defaults to frozen catalog; future config is opt-in and read-only', { skip: bundleSkipped }, async () => {
  const mini = makeMiniReact()
  const calls = stubFetch(call => {
    if (call.url.startsWith('/session')) return { status: 200, json: { sessionId: 'sess-1', revision: 'r', capabilities: { nextSessionPreview: true }, snapshot: { revision: 's', registeredAt: '2026-02-01T00:00:00Z', tools: ['mcp__beta__query'] } } }
    if (call.url.startsWith('/preview')) return { status: 200, json: { ...previewDoc(), forNextSession: true, entries: [{ name: 'new-gamma', level: 'global', source: 'standard', layerId: 'global:standard', def: { command: 'node' }, disabled: false, revision: 'r' }] } }
    return { status: 500, json: { error: 'Unexpected write' } }
  })
  const createdOpts = [], opened = []
  const sessionsFace = { create: async opts => { createdOpts.push(opts); return 'new-sess-9' }, open: id => opened.push(id), list: { getSnapshot: () => ({ byId: { 'sess-1': { cwd: 'C:/ws/probe' } } }) } }
  const { registrations } = await loadClient(mini, { sessions: sessionsFace })
  const view = registrations.find(r => r.slot === 'conversation.view')
  mini.render(mini.createElement(view.component, { sessionId: 'sess-1' }))
  await flush()
  assert.ok(findText(mini, 'beta'))
  assert.ok(findText(mini, 'query'))
  assert.equal(findText(mini, 'mcp__beta__query'), false, 'full IDs are not prose')
  assert.equal(findText(mini, 'new-gamma'), false)
  assert.equal(calls.some(call => call.url.startsWith('/preview')), false, 'default view never substitutes latest config')
  await clickButton(mini, 'sessionConfigTab')
  assert.ok(findText(mini, 'new-gamma'))
  assert.ok(calls.some(call => call.url === '/preview?ss=sess-1&next=1'))
  await clickButton(mini, 'startNext')
  assert.deepEqual(createdOpts, [{ cwd: 'C:/ws/probe' }])
  assert.deepEqual(opened, ['new-sess-9'])
  assert.ok(calls.every(call => call.method === 'GET'), 'conversation view never rewrites config or reloads tools')
})


test('pages: session tab hides unavailable start-next rather than showing a disabled panel', { skip: bundleSkipped }, async () => {
  const mini = makeMiniReact()
  stubFetch((call) => {
    if (call.url.startsWith('/preview')) return { status: 200, json: previewDoc() }
    if (call.url.startsWith('/session')) return { status: 200, json: { sessionId: 'sess-1', revision: 'r' } }
    return { status: 500, json: { error: 'no route' } }
  })
  const { registrations } = await loadClient(mini)
  const view = registrations.find((r) => r.slot === 'conversation.view')
  mini.render(mini.createElement(view.component, { sessionId: 'sess-1' }))   // no startNext
  await flush()
  const buttons = findAll(mini.tree(), (el) => el.type === 'button' && el.props['aria-label'] === 'startNext')
  assert.equal(buttons.length, 0)
  assert.equal(findText(mini, 'startNextUnavailable'), false)
  assert.ok(findText(mini, 'sessionSnapshotMissing'), 'missing snapshot never becomes current config')
})

test('pages (wired bridge): MCP services renders data and lifecycle actions without Advanced requests', { skip: bundleSkipped }, async () => {
  const mini = makeMiniReact()
  const seenUrls = []
  stubFetch((call) => {
    seenUrls.push(call.method + ' ' + call.url)
    const url = call.url
    if (url.startsWith('/preview')) return { status: 200, json: previewDoc() }
    if (url.startsWith('/engine')) return { status: 200, json: { off: true } }
    if (url.startsWith('/workspaces')) return { status: 200, json: { items: [{ id: 'ws1', path: 'C:/ws/one' }] } }
    if (url.startsWith('/session')) return { status: 200, json: { sessionId: 'sess-1', revision: 'r', snapshot: { revision: 's', registeredAt: 'R-AT', tools: ['mcp__alpha__query'] } } }
    if (/^\/mcp\/alpha\/calls\//.test(url)) return { status: 200, json: { call: { seq: 9, tool: 'x', output: 'FULL' } } }
    if (/^\/mcp\/alpha\/calls/.test(url)) return { status: 200, json: { name: 'alpha', calls: [{ seq: 9, ts: 'TS', tool: 'query', preview: 'PV' }], page: 0, more: false } }
    if (/^\/mcp\/alpha\/(status|tools|resources|prompts)/.test(url)) return { status: 200, json: { lifecycle: 'started', state: 'up', type: 'proc', tools: [{ name: 'query', description: 'd' }] } }
    if (/^\/mcp\/alpha\/ensure/.test(url)) return { status: 200, json: { name: 'alpha', lifecycle: 'started' } }
    return { status: 500, json: { error: 'no route for ' + call.method + ' ' + url } }
  })
  const { registrations } = await loadClient(mini)
  const section = registrations.find((r) => r.slot === 'settings.section')
  mini.render(mini.createElement(section.component, { t: (key) => key }))
  await flush()
  assert.ok(findText(mini, 'alpha'), 'workbench entries render')

  // MCP services: detail with lifecycle buttons + a populated calls tab
  await clickButton(mini, 'alpha')
  assert.ok(findText(mini, 'started'), 'status tab shows lifecycle')
  // Lifecycle is rare enough not to spend the header's width on: it lives in
  // the detail panel's ⋯ menu.
  findAll(mini.tree(), (el) => typeof el.props.className === 'string' && el.props.className === 'mmc-more').at(-1).el.props.onClick()
  await flush()
  for (const label of ['start', 'stop', 'restart']) {
    assert.ok(findAll(mini.tree(), (el) => el.type === 'button' && textOfEl(el) === label).length > 0, 'lifecycle item ' + label)
  }
  await clickButton(mini, 'calls')
  assert.ok(findText(mini, 'query'), 'calls tab lists the tool call')
  assert.ok(!findText(mini, 'bridgePending'), 'calls tab fully wired')
  assert.ok(seenUrls.every((u) => !/\/(?:tokens|token\/default|listener|memory|creds)(?:[/?]|$)/.test(u)),
    'MCP services never fetches Advanced-only routes')
})

function previewDoc(revision = 'rev-open-0001') {
  return {
    layers: [
      { level: 'global', source: 'standard', layerId: 'global:standard', label: 'HOST-PATH/.agents/.mcp.json', exists: true, revision },
      { level: 'global', source: 'native', layerId: 'global:native', label: 'native:global', exists: false, revision: 'rn' },
    ],
    entries: [
      { name: 'alpha', level: 'global', source: 'standard', layerId: 'global:standard', def: { command: 'node a.js' }, inherited: false, overrides: [], disabled: false, revision },
    ],
    conflicts: [], problems: [],
  }
}

test('mini React canary: the OLD conditional-call pattern (page functions invoked directly inside a parent) trips the hook-order check', async () => {
  const mini = makeMiniReact()
  // Exactly the pre-repair Workbench shape: two hook-using page functions
  // called as conditional plain-function children of one component.
  const PageA = () => { const [a] = mini.useState('a'); const [b] = mini.useState('b'); return mini.createElement('div', {}, a + b) }
  const PageB = () => { const [a] = mini.useState('a'); return mini.createElement('div', {}, a) }
  let tab = 'a'
  const OldWorkbench = () => mini.createElement('div', {},
    mini.useState('x')[0],
    tab === 'a' ? PageA() : PageB())
  mini.render(mini.createElement(OldWorkbench, {}))
  tab = 'b'
  assert.throws(() => mini.render(mini.createElement(OldWorkbench, {})), /HOOK ORDER VIOLATION/)
})

// cleanup for the skipped-bundle case keeps output honest
if (bundleSkipped) {
  console.log('NOTE: page tests skipped — esbuild bundle failed:', String(bundled.error?.message ?? bundled.error))
}

// ---------------------------------------------------------------- display regressions (ui.ts + mcp.ts)

// A THROWING top-level import here does not fail one test — it aborts the
// module, so every test below this line silently stops existing and the run
// still reports green-ish. (That is exactly what a bad './icons.js' specifier
// did: 14 tests vanished from the count and nothing said so.) Catch it, and
// let one test report it.
let uiMod
let uiImportError
try { uiMod = await import('../src/client/ui.ts') } catch (error) { uiImportError = error; uiMod = { css: '', kit: () => ({}) } }

test('ui.ts loads as SOURCE — a broken specifier here deletes every test below it', () => {
  assert.equal(uiImportError, undefined, 'ui.ts failed to import: ' + String(uiImportError))
})

/** Body of ONE rule, matched on the exact selector (".mmc-item" never matches ".mmc-item:hover"). */
/**
 * The declaration block of the rule whose selector is EXACTLY `selector`.
 * A naive indexOf matches a descendant selector that merely ends with it
 * (".mmc-item[data-off] .mmc-name{" contains ".mmc-name{"), which silently
 * reads the wrong rule — so anchor on a rule boundary.
 */
function cssRule(selector) {
  // The stylesheet is written one rule per line, so a chunk carries the
  // newline that ended the previous rule.
  // A rule may be preceded by a /* why */ comment, which lands in the same
  // chunk as the selector that follows it.
  const nameOfChunk = (chunk) => chunk.split('{')[0].replace(/\/\*[\s\S]*?\*\//g, '').trim()
  const at = uiMod.css.split('}').findIndex((chunk) => nameOfChunk(chunk) === selector)
  assert.notEqual(at, -1, 'stylesheet has no rule whose selector is exactly ' + selector)
  return uiMod.css.split('}')[at].split('{').slice(1).join('{')
}

function findClass(mini, cls) {
  return findAll(mini.tree(), (el) => typeof el.props.className === 'string' && el.props.className.split(' ').includes(cls))
}

test('css: conversation view centers in its pane and hides only the inert chat-width siblings', () => {
  assert.match(cssRule('.mmc-root.mmc-session'), /max-width:800px/)
  assert.match(cssRule('.mmc-root.mmc-session'), /margin-inline:auto/)
  assert.match(cssRule('[data-conversation-scroll]:has(.mmc-session) ~ [data-width-handle]'), /display:none/)
  assert.equal(uiMod.css.split(String.fromCharCode(10)).some(line => line.trim().startsWith('[data-width-handle]{')), false, 'no global handle override')
  assert.doesNotMatch(cssRule('.mmc-root.mmc-session'), /height:100%|overflow:auto/, 'host owns scroll height')
})

test('css: an entry row reflows in a narrow pane instead of clipping its last action', () => {
  // Root cause of the clipped "Dele": the row was a nowrap flex row whose
  // min-content (fixed-width name + nowrap chips + four unshrinkable buttons)
  // exceeds a ~660px settings pane, so the tail overflowed the border box.
  assert.match(cssRule('.mmc-r'), /flex-wrap:wrap/, 'rows must wrap rather than overflow')
  assert.match(cssRule('.mmc-btn'), /white-space:nowrap/, 'button labels never break mid-word')
  assert.doesNotMatch(cssRule('.mmc-name'), /min-width:1\d\dpx/, 'the name must shrink, not reserve a fixed column')
  assert.match(cssRule('.mmc-name'), /text-overflow:ellipsis/, 'a long name truncates instead of pushing the row wide')
  assert.match(cssRule('.mmc-actions'), /margin-left:auto/, 'actions stay one right-aligned group so they line up row to row')
})

test('css: a disabled primary button stops looking like the page\'s main action', () => {
  // opacity:.4 over a near-black fill is still a dark filled block — the
  // strongest thing on the page, and unclickable. "Apply" sat disabled on the
  // Advanced tab looking exactly like the button you were meant to press.
  assert.match(cssRule('.mmc-btn:disabled'), /opacity:\.4/)
  assert.doesNotMatch(cssRule('.mmc-btn[data-primary]:disabled'), /--mmc-brand/, 'a disabled primary drops the brand fill')
})

test('css: every class the pages use has a rule, and every host token has a fallback', () => {
  // Two real bugs this catches. (1) .mmc-table was used by the Data grid and
  // had NO rule at all, so the grid rendered as a bare HTML table for as long
  // as it existed. (2) The stylesheet referenced --dsw-alias-accent-default,
  // which THIS host does not define, with no fallback — so the primary button
  // computed to background:transparent;border:none and was invisible. Neither
  // is visible in a synthetic preview that defines the tokens itself.
  const dir = join(here, '..', 'src', 'client')
  const sources = []
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(d, entry.name))
      else if (entry.name.endsWith('.ts')) sources.push(readFileSync(join(d, entry.name), 'utf8'))
    }
  }
  walk(dir)
  const source = sources.join(' ')
  const used = new Set()
  for (const m of source.matchAll(/'((?:mmc-[a-z0-9-]+ ?)+)'/g)) for (const c of m[1].trim().split(' ')) used.add(c)
  const styled = new Set([...uiMod.css.matchAll(/\.(mmc-[a-z0-9-]+)/g)].map((m) => m[1]))
  const unstyled = [...used].filter((c) => !styled.has(c)).sort()
  assert.deepEqual(unstyled, [], 'these classes are rendered but have no CSS rule')

  // Every host design token must carry a literal fallback: this host resolves
  // some of the --dsw-alias-* family and not others, and a bare var() that
  // does not resolve makes the declaration invalid — the colour silently
  // becomes transparent or currentColor rather than failing loudly.
  const bare = [...uiMod.css.matchAll(/var\(\s*(--dsw-[a-z0-9-]+)\s*\)/g)].map((m) => m[1])
  assert.deepEqual([...new Set(bare)].sort(), [], 'host tokens referenced without a fallback')

  // And the other direction: a rule nothing renders is dead weight that the
  // next reader has to decide about. .mmc-title survived a page-header
  // rewrite this way, styling an element that no longer existed.
  const orphan = [...styled].filter((c) => !used.has(c)).sort()
  assert.deepEqual(orphan, [], 'these CSS rules style a class nothing renders')
})

const i18nMod = await import('../src/client/i18n.ts')

test('i18n: the two dictionaries answer the same set of keys', () => {
  // Dict is Record<string, string>, so TypeScript will not notice a key added
  // to one dictionary and forgotten in the other — the miss shows up only as
  // a raw key name printed in the UI, in the other language, at runtime.
  const enKeys = Object.keys(i18nMod.en).sort()
  const zhKeys = Object.keys(i18nMod.zh).sort()
  assert.deepEqual(enKeys.filter((k) => !zhKeys.includes(k)), [], 'keys present in en but missing from zh')
  assert.deepEqual(zhKeys.filter((k) => !enKeys.includes(k)), [], 'keys present in zh but missing from en')
})

// The kit only needs createElement, so a section can be inspected as a plain
// element tree without mounting a component.
const rawReact = { createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }) }
function rawKids(el) {
  return (el?.props?.children ?? []).flat(Infinity).filter((c) => c !== null && c !== undefined && typeof c === 'object')
}
function rawFind(el, cls) {
  if (el === null || el === undefined || typeof el !== 'object') return undefined
  if (Array.isArray(el)) { for (const c of el) { const hit = rawFind(c, cls); if (hit !== undefined) return hit } return undefined }
  const cn = el.props?.className
  if (typeof cn === 'string' && cn.split(' ').includes(cls)) return el
  for (const c of rawKids(el)) { const hit = rawFind(c, cls); if (hit !== undefined) return hit }
  return undefined
}

test('pages (layout): a section labels its group above and explains it below', () => {
  // The label and the sentence explaining the group used to share ONE flex
  // line with the group's buttons, which on a ~560px pane wrapped into a
  // run-on. Apple's settings idiom splits them: a short label over the group,
  // the explanation as a footnote UNDER it, where prose belongs.
  const k = uiMod.kit(rawReact)
  const node = k.section('Tokens', { sub: 'Named per-client bearers.', actions: [k.btn('New', () => {})] }, k.note('body'))
  const head = rawFind(node, 'mmc-shead')
  assert.ok(head !== undefined, 'a section renders a header')
  assert.ok(rawFind(head, 'mmc-label') !== undefined, 'the label lives in the header')
  assert.ok(rawFind(head, 'mmc-actions') !== undefined, "the group's actions stay in the header")
  assert.ok(rawFind(head, 'mmc-foot') === undefined, 'the description is NOT wedged beside the label')
  const kids = rawKids(node)
  assert.equal(kids[0].props.className, 'mmc-shead', 'header first')
  assert.equal(kids.at(-1).props.className, 'mmc-foot', 'the footnote comes last, under the content')
  // The body is a SIBLING of the header, not a child of it.
  assert.ok(rawFind(head, 'mmc-note') === undefined, 'content is not nested inside the header')
  assert.ok(rawFind(node, 'mmc-note') !== undefined, 'the body still renders')
})

test('pages (layout): a row cannot grow a control panel', () => {
  // The invariant the row model exists to hold: identity, then AT MOST a
  // switch and a ⋯ menu (plus the drill-in chevron). Rows assembled by hand
  // reached seven buttons apiece and ran the pane out of width.
  const k = uiMod.kit(rawReact)
  const node = k.row({
    name: 'context7', icon: 'redis', meta: 'global:native', state: 'ok',
    onOpen: () => {}, open: false,
    toggle: { on: true, onChange: () => {} },
    menu: [{ label: 'Edit', onPick: () => {} }, { label: 'Delete', danger: true, onPick: () => {} }],
  })
  const trail = rawFind(node, 'mmc-trail')
  assert.ok(trail !== undefined, 'the row has a trailing control area')
  const plainButtons = rawKids(trail).filter((c) => c.type === 'button' && c.props.className === 'mmc-btn')
  assert.deepEqual(plainButtons, [], 'no loose buttons ride the row — they belong in the ⋯ menu')
  assert.ok(rawFind(trail, 'mmc-sw') !== undefined, 'the switch is the one always-visible control')
  assert.ok(rawFind(trail, 'mmc-chev') !== undefined, 'a drill-in row shows a chevron')
  // The kind leads the row as a tinted tile, not as a chip that must be read.
  const icon = rawFind(node, 'mmc-icon')
  assert.ok(icon !== undefined, 'the type renders as an icon tile')
  assert.equal(icon.props.style.background, '#d82c20', 'redis wears its own brand colour')
  assert.equal(icon.props['aria-label'], 'redis', 'the tile still says which kind it is, for a screen reader')
  // An icon replaces the status dot; an ERROR keeps it, because a fault earns
  // the pixels.
  assert.ok(rawFind(node, 'mmc-dot') === undefined, 'a healthy row does not carry both a tile and a dot')
  assert.ok(rawFind(k.row({ name: 'x', icon: 'redis', state: 'bad' }), 'mmc-dot') !== undefined, 'a failing row keeps its dot')
})

test('pages (layout): a switch reports the state instead of naming the action', () => {
  const k = uiMod.kit(rawReact)
  let got
  const on = k.toggle(true, (next) => { got = next }, { label: 'context7' })
  assert.equal(on.props.role, 'switch')
  assert.equal(on.props['aria-checked'], 'true', 'the control SAYS it is on')
  assert.equal(on.props['aria-label'], 'context7')
  on.props.onClick()
  assert.equal(got, false, 'pressing an on switch asks for off')
  assert.equal(k.toggle(false, () => {}).props['aria-checked'], 'false')
  assert.match(cssRule('.mmc-sw[aria-checked=true]'), /--mmc-brand/, 'the on state uses the host brand, not a foreign accent')
})

test('pages (layout): a row carries ONE chip, the rest of its facts are prose', () => {
  // Four bordered chips per row (host:port, auth, state, throughput) read as
  // four buttons and wrap into a block on a narrow pane. kit.facts is the
  // single grey run that replaced them; it must ellipsize and keep the full
  // text reachable as a title.
  const k = uiMod.kit(rawReact)
  const line = k.facts('a@h:22', '', 'connected', undefined, 'x')
  assert.equal(line.props.className, 'mmc-meta')
  assert.equal(line.props.title, 'a@h:22 · connected · x', 'empty parts are dropped, not rendered as bare separators')
  assert.equal(k.facts('', undefined, false), null, 'a row with nothing to say renders no fact line at all')
  assert.match(cssRule('.mmc-meta'), /text-overflow:ellipsis/)
})

test('css: a key/value cell binds its value to its own label, not to the next column', () => {
  // Root cause of "lifecycle started state unknown": space-between parked the
  // value at the far right of its grid cell, 6px from the NEXT cell's label.
  const kv = cssRule('.mmc-kv')
  assert.doesNotMatch(kv, /justify-content:space-between/, 'space-between is what glued values to the next label')
  assert.match(kv, /display:grid/, 'label and value belong to one two-column grid')
})

function displayDoc() {
  return {
    layers: [
      { level: 'global', source: 'standard', layerId: 'global:standard', label: 'L', exists: true, revision: 'r' },
      { level: 'global', source: 'native', layerId: 'global:native', label: 'L', exists: false, revision: 'r' },
    ],
    entries: [
      { name: 'alpha', level: 'global', source: 'native', layerId: 'global:native', def: { type: 'echo' }, inherited: true, overrides: [], disabled: false, revision: 'r' },
      { name: 'beta', level: 'global', source: 'native', layerId: 'global:native', def: { type: 'echo' }, inherited: false, overrides: [], disabled: true, revision: 'r' },
    ],
    conflicts: [], problems: [],
  }
}

function displayFetch() {
  return stubFetch((call) => {
    if (call.url.startsWith('/preview')) return { status: 200, json: displayDoc() }
    if (call.url.startsWith('/engine')) return { status: 200, json: { off: true } }
    if (/^\/mcp\/alpha\/ensure/.test(call.url)) return { status: 200, json: { name: 'alpha' } }
    if (/^\/mcp\/alpha\/status/.test(call.url)) return { status: 200, json: { lifecycle: 'started', state: 'up', type: 'echo' } }
    return { status: 500, json: { error: 'no route for ' + call.method + ' ' + call.url } }
  })
}

/** Nodes with `cls` inside one already-found node. */
function within(node, cls) {
  return findAll(node, (el) => typeof el.props.className === 'string' && el.props.className.split(' ').includes(cls))
}

test('pages (display): a row states identity, it is not a control panel', { skip: bundleSkipped }, async () => {
  const mini = makeMiniReact()
  displayFetch()
  const { registrations } = await loadClient(mini)
  const section = registrations.find((r) => r.slot === 'settings.section')
  mini.render(mini.createElement(section.component, { t: (key) => key }))
  await flush()
  const rows = findClass(mini, 'mmc-r')
  assert.equal(rows.length, 2, 'both entries rendered')
  for (const row of rows) {
    // The connection type leads the row as a tinted tile, not as a chip that
    // has to be read. Layer / inherited / pending / disabled became muted
    // text, and edit/delete moved into the ⋯ menu: four chips beside four
    // buttons is HOW this list ran out of width.
    assert.equal(within(row, 'mmc-tag').length, 0, 'no chips left on the row')
    assert.equal(within(row, 'mmc-icon').length, 1, 'the type leads the row as an icon tile')
    const trail = within(row, 'mmc-trail')
    assert.equal(trail.length, 1, 'the row keeps one trailing control area')
    const controls = findAll(trail[0], (el) => el.type === 'button')
    assert.equal(controls.length, 2, 'exactly two: the on/off switch and the ⋯ menu')
    assert.equal(controls[0].el.props.role, 'switch', 'the always-visible control reports state')
    assert.equal(controls[1].el.props.className, 'mmc-more', 'everything else is one press deeper')
  }
  // The facts did not vanish; they stopped shouting.
  const meta = findClass(mini, 'mmc-meta').map((n) => textOf(n)).join(' | ')
  for (const fact of ['global:native', 'inherited', 'disabled']) {
    assert.ok(meta.includes(fact), 'the row still states ' + fact + ', as muted text')
  }
  // And the name is the disclosure control, so no Detail button is needed.
  assert.equal(findAll(mini.tree(), (el) => el.type === 'button' && el.props['aria-label'] === 'detail').length, 0)
  assert.ok(findAll(mini.tree(), (el) => el.type === 'button' && el.props['aria-label'] === 'alpha').length === 1)
})

test('pages (display): MCP status labels are translated and the panel opens under its own row', { skip: bundleSkipped }, async () => {
  const mini = makeMiniReact()
  displayFetch()
  const { registrations } = await loadClient(mini)
  const section = registrations.find((r) => r.slot === 'settings.section')
  mini.render(mini.createElement(section.component, { t: (key) => 'T#' + key }))
  await flush()
  await clickButton(mini, 'alpha')
  await flush()
  assert.ok(findText(mini, 'T#lifecycle'), 'the lifecycle label goes through the dictionary')
  assert.ok(findText(mini, 'T#pids'), 'the pids label goes through the dictionary')
  const entryList = findClass(mini, 'mmc-rows').find((l) => textOf(l).includes('alpha'))
  assert.ok(entryList !== undefined, 'the entry list rendered')
  // Lifecycle moved into the panel's ⋯ menu, so open it to see the verbs.
  const panel = findClass(mini, 'mmc-card').find((c) => textOf(c).includes('T#lifecycle'))
  assert.ok(panel !== undefined, 'the detail panel rendered')
  within(panel, 'mmc-more')[0].el.props.onClick()
  await flush()
  const reopened = findClass(mini, 'mmc-rows').find((l) => textOf(l).includes('alpha'))
  assert.ok(textOf(reopened).includes('T#start'), 'the detail panel sits beside its row, not parked above the list')
})

test('fields: the schema round-trips a definition without inventing or losing keys', async () => {
  const f = await import('../src/client/fields.ts')
  // A native layer offers the adapters; a standard .mcp.json cannot hold them.
  assert.deepEqual(f.typesFor('global:standard'), ['stdio', 'remote'])
  assert.ok(f.typesFor('project:native').includes('http'), 'native layers offer the engine adapters')
  assert.ok(f.typesFor('global:native').includes('proc'))
  // Standard entries have no `type` key — the SHAPE is the type, because
  // .mcp.json is shared with other MCP clients and a dsh-only discriminator
  // in it is pollution.
  assert.equal(f.typeOfDef({ command: 'npx' }, 'global:standard'), 'stdio')
  assert.equal(f.typeOfDef({ url: 'https://x/mcp' }, 'global:standard'), 'remote')
  assert.equal(f.blankDef('stdio').type, undefined, 'a standard draft never carries a type key')
  assert.deepEqual(f.blankDef('http'), { type: 'http' })

  const timeout = f.fieldsFor('proc').find((x) => x.k === 'timeoutMs')
  const expose = f.fieldsFor('proc').find((x) => x.k === 'exposeResources')
  // Numbers are stored as numbers; clearing a field REMOVES the key rather
  // than storing "".
  assert.deepEqual(f.applyField({ type: 'proc' }, timeout, '180000'), { type: 'proc', timeoutMs: 180000 })
  assert.deepEqual(f.applyField({ type: 'proc', timeoutMs: 180000 }, timeout, ''), { type: 'proc' })
  assert.throws(() => f.applyField({}, timeout, 'not-a-number'), /not a number/)
  // A boolean equal to its default is left out, so the stored file stays minimal.
  assert.deepEqual(f.applyField({ type: 'proc' }, expose, true), { type: 'proc' })
  assert.deepEqual(f.applyField({ type: 'proc' }, expose, false), { type: 'proc', exposeResources: false })

  // KEY=VALUE and one-per-line blocks parse into the shapes the engine reads.
  const env = f.fieldsFor('stdio').find((x) => x.k === 'env')
  const args = f.fieldsFor('stdio').find((x) => x.k === 'args')
  assert.deepEqual(f.applyField({}, env, 'A=1\n\nB = two '), { env: { A: '1', B: 'two' } })
  assert.deepEqual(f.applyField({}, args, '-y\n@scope/pkg\n'), { args: ['-y', '@scope/pkg'] })
  assert.equal(f.fieldValue({ env: { A: '1' } }, env), 'A=1')
  assert.equal(f.fieldValue({}, expose), true, 'an unset boolean reads as its default')

  // THE round-trip guarantee: a key the form does not model survives an edit
  // through the form, and is reported rather than silently dropped.
  const exotic = { type: 'proc', command: 'npx -y pkg', idleMs: 60000, weird: { deep: true } }
  assert.deepEqual(f.unknownKeys(exotic, 'proc'), ['idleMs', 'weird'])
  assert.deepEqual(
    f.applyField(exotic, timeout, '30000'),
    { type: 'proc', command: 'npx -y pkg', idleMs: 60000, weird: { deep: true }, timeoutMs: 30000 },
    'editing one field must not rebuild the definition from the schema',
  )
  // Switching type keeps what both shapes share and drops what the new one cannot use.
  assert.deepEqual(f.retype({ type: 'proc', command: 'npx', description: 'd' }, 'proc', 'http'), { description: 'd', type: 'http' })
  assert.deepEqual(f.retype({ command: 'npx', args: ['-y'] }, 'stdio', 'remote'), {}, 'stdio and remote are mutually exclusive in .mcp.json')
})

test('pages (form): an adapter is configured through fields, not by knowing its JSON by heart', { skip: bundleSkipped }, async () => {
  const mini = makeMiniReact()
  let saved
  stubFetch((call) => {
    if (call.url.startsWith('/preview')) return { status: 200, json: displayDoc() }
    if (call.url.startsWith('/engine')) return { status: 200, json: { off: true } }
    if (call.url.startsWith('/entry')) { saved = call.body; return { status: 200, json: { revision: 'r2' } } }
    return { status: 500, json: { error: 'no route for ' + call.method + ' ' + call.url } }
  })
  const { registrations } = await loadClient(mini)
  const section = registrations.find((r) => r.slot === 'settings.section')
  mini.render(mini.createElement(section.component, { t: (key) => key }))
  await flush()
  await clickButton(mini, 'alpha')
  await openRowMenu(mini, 'alpha')
  await clickInRow(mini, 'alpha', 'edit')
  await flush()

  // The editor opens on the FORM, with the entry's current type selected.
  const typeSelect = findAll(mini.tree(), (el) => el.type === 'select' && el.props.value === 'echo')[0]
  assert.ok(typeSelect !== undefined, 'the type picker shows the definition’s own type')
  const offered = (typeSelect.el.props.children ?? []).flat(Infinity).map((c) => c.props.value)
  for (const driver of ['proc', 'http', 'echo']) {
    assert.ok(offered.includes(driver), 'a native layer offers ' + driver)
  }

  typeSelect.el.props.onChange({ target: { value: 'http' } })
  await flush()
  const field = (label) => within(mini.tree(), 'mmc-field').find((n) => textOf(n).startsWith(label))
  const boxIn = (label) => findAll(field(label), (el) => el.type === 'input' || el.type === 'textarea')[0]
  assert.ok(boxIn('Endpoint URL') !== undefined, 'http fields rendered with their labels')
  // Re-query between interactions: each commit re-renders the editor, and a
  // handler captured before it belongs to a render that no longer exists.
  boxIn('Endpoint URL').el.props.onChange({ target: { value: 'https://mcp.example.test/mcp' } })
  await flush()

  await clickButton(mini, 'save')
  assert.deepEqual(saved.def, { type: 'http', url: 'https://mcp.example.test/mcp' }, 'the form writes the engine’s own key names')
  assert.equal(saved.expectedRevision, 'r', 'the R5 revision contract is untouched by the form')
})

test('pages (import): a pasted .mcp.json is planned as a dry run, then applied entry by entry', { skip: bundleSkipped }, async () => {
  const mini = makeMiniReact()
  let applied = null
  const calls = stubFetch((call) => {
    if (call.url.startsWith('/preview')) return { status: 200, json: displayDoc() }
    if (call.url.startsWith('/engine')) return { status: 200, json: { off: true } }
    if (call.url.startsWith('/import')) {
      // the bridge plans first and only writes when apply:true rides along
      if (call.body.apply !== true) {
        return { status: 200, json: { layerId: call.body.layerId, add: [{ name: 'ctx7', def: {} }], skip: [{ name: 'weird', reason: 'needs a command or a url' }] } }
      }
      applied = call.body
      return { status: 200, json: { layerId: call.body.layerId, added: ['ctx7'], failed: [], skip: [], revision: 'r2' } }
    }
    return { status: 500, json: { error: 'no route for ' + call.method + ' ' + call.url } }
  })
  const { registrations } = await loadClient(mini)
  const section = registrations.find((r) => r.slot === 'settings.section')
  mini.render(mini.createElement(section.component, { t: (key) => key }))
  await flush()

  await openPageMenu(mini)
  await clickButton(mini, 'importTitle')
  assert.ok(findText(mini, 'importHint'), 'the import panel opened')
  const box = textareas(mini)[0]
  assert.ok(box !== undefined, 'the paste box rendered')
  box.el.props.onChange({ target: { value: '{"mcpServers":{"ctx7":{"command":"npx"}}}' } })
  await flush()

  await clickButton(mini, 'importPlan')
  assert.equal(applied, null, 'planning writes nothing')
  assert.ok(findText(mini, 'ctx7'), 'the plan lists the entry it would add')
  assert.ok(findText(mini, 'needs a command or a url'), 'the plan explains what it skipped')

  await clickButton(mini, 'importApply')
  assert.ok(applied !== null, 'apply reached the bridge')
  assert.equal(applied.apply, true)
  assert.equal(applied.layerId, 'global:standard', 'imports land on the chosen layer')
  assert.ok(findText(mini, 'importDone'), 'the result reports what landed')
  assert.ok(calls.filter((c) => c.url.startsWith('/preview')).length >= 2, 'the list refreshes after an import')
})

test('pages (arrange): grouping and ordering go to /view, and arrange mode swaps the row actions', { skip: bundleSkipped }, async () => {
  const mini = makeMiniReact()
  let meta = { version: 1, entries: {}, groups: [] }
  const posted = []
  stubFetch((call) => {
    if (call.url.startsWith('/preview')) return { status: 200, json: displayDoc() }
    if (call.url.startsWith('/engine')) return { status: 200, json: { off: true } }
    if (call.url.startsWith('/view')) {
      if (call.method === 'POST') {
        posted.push(call.body)
        meta = { version: 1, entries: { ...meta.entries, [call.body.name]: { group: call.body.group } }, groups: ['db'] }
      }
      return { status: 200, json: meta }
    }
    return { status: 500, json: { error: 'no route for ' + call.method + ' ' + call.url } }
  })
  globalThis.prompt = () => 'db'
  const { registrations } = await loadClient(mini)
  const section = registrations.find((r) => r.slot === 'settings.section')
  mini.render(mini.createElement(section.component, { t: (key) => key }))
  await flush()

  // normal mode: the switch is the row's only always-visible control, and the
  // ⋯ holds edit/delete rather than the arrange verbs.
  assert.equal(findAll(mini.tree(), (el) => el.props.role === 'switch').length, 2, 'one switch per row')
  await openRowMenu(mini, 'alpha')
  assert.ok(textOf(rowNamed(mini, 'alpha')).includes('edit'), 'normal mode offers edit')
  assert.ok(!textOf(rowNamed(mini, 'alpha')).includes('moveUp'), 'and not the arrange verbs')
  await openRowMenu(mini, 'alpha')   // close it again

  await openPageMenu(mini)
  await clickButton(mini, 'arrange')
  // arrange mode REPLACES the row menu rather than adding to it
  await openRowMenu(mini, 'alpha')
  assert.ok(textOf(rowNamed(mini, 'alpha')).includes('moveUp'), 'arrange mode offers the move verbs')
  assert.ok(!textOf(rowNamed(mini, 'alpha')).includes('delete'), 'edit/delete step aside while arranging')

  await clickInRow(mini, 'alpha', 'moveUp')
  assert.deepEqual(posted.at(-1), { name: 'alpha', move: 'up' }, 'a move addresses the entry by name')

  await openRowMenu(mini, 'alpha')
  await clickInRow(mini, 'alpha', 'groupSet')
  assert.deepEqual(posted.at(-1), { name: 'alpha', group: 'db' }, 'grouping posts the typed name')
  assert.ok(findText(mini, 'db'), 'the group heading renders once metadata exists')
})

test('tool-args: a tool schema becomes real inputs instead of an empty {}', async () => {
  const a = await import('../src/client/tool-args.ts')
  // The shape a real MCP answers tools/list with: typed properties, a
  // required list, descriptions, an enum, a default.
  const schema = {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'The key to read.' },
      count: { type: 'integer', default: 10 },
      pattern: { type: 'string', enum: ['scan', 'keys'] },
      fields: { type: 'array', items: { type: 'number' } },
      filter: { type: 'object' },
      raw: { type: 'boolean' },
    },
    required: ['key', 'raw'],
  }
  const fields = a.argFieldsOf(schema)
  assert.deepEqual(fields.map((f) => f.k), ['key', 'count', 'pattern', 'fields', 'filter', 'raw'],
    'one field per property, in the schema order')
  assert.deepEqual(fields.map((f) => f.kind), ['string', 'number', 'string', 'array', 'object', 'boolean'])
  assert.deepEqual(fields.filter((f) => f.required).map((f) => f.k), ['key', 'raw'])
  assert.equal(fields[0].description, 'The key to read.', 'the schema description reaches the panel')
  assert.deepEqual(fields[2].choices, ['scan', 'keys'], 'an enum becomes a dropdown, not a free-text box')
  assert.equal(fields[1].placeholder, '10', 'a declared default is SHOWN')
  assert.equal(fields[3].area, true, 'arrays and objects get a textarea')
  assert.equal(fields[0].area, false)
  // A default is shown but never pre-filled: a value the panel invents is one
  // the server can no longer default for itself.
  assert.deepEqual(a.missingRequired(fields, {}), ['key', 'raw'])

  const byKey = (k) => fields.find((f) => f.k === k)
  // Numbers are numbers, array lines are coerced to the DECLARED item type,
  // objects are parsed — a form that posts "12" where the schema says 12 is
  // rejected by any server that validates its input.
  assert.deepEqual(a.applyArg({}, byKey('count'), '25'), { count: 25 })
  assert.deepEqual(a.applyArg({}, byKey('fields'), '1\n 2 \n\n3'), { fields: [1, 2, 3] })
  assert.deepEqual(a.applyArg({}, byKey('filter'), '{"a":1}'), { filter: { a: 1 } })
  // The two silent drops the gateway's reader had, now reported.
  assert.throws(() => a.applyArg({}, byKey('count'), 'ten'), /not a number/)
  assert.throws(() => a.applyArg({}, byKey('filter'), '{oops'), /not valid JSON/)
  // Clearing a field REMOVES the key: "I left this out" and "I sent an empty
  // string" are different calls, and the form has no other way to say the first.
  assert.deepEqual(a.applyArg({ key: 'k' }, byKey('key'), ''), {})
  // An optional false is an omission (an untouched form stays `{}`); a
  // REQUIRED false is a value the server asked for, so it is sent.
  assert.deepEqual(a.applyArg({}, byKey('raw'), false), { raw: false }, 'required boolean false is expressible')
  const optionalBool = a.argFieldsOf({ properties: { dry: { type: 'boolean' } } })[0]
  assert.deepEqual(a.applyArg({}, optionalBool, false), {})
  assert.deepEqual(a.applyArg({}, optionalBool, true), { dry: true })

  // The argument object is the single source of truth, so an edit through one
  // field must not rebuild the call from the schema — a key the schema does
  // not declare (a stale history entry, a server that under-declares) rides
  // through and is reported rather than silently dropped.
  const stale = { key: 'k', legacyFlag: 7 }
  assert.deepEqual(a.undeclaredKeys(fields, stale), ['legacyFlag'])
  assert.deepEqual(a.applyArg(stale, byKey('count'), '3'), { key: 'k', legacyFlag: 7, count: 3 })

  // Reading back for display: arrays one per line, objects pretty JSON.
  assert.equal(a.argValue({ fields: [1, 2] }, byKey('fields')), '1\n2')
  assert.equal(a.argValue({ filter: { a: 1 } }, byKey('filter')), '{\n  "a": 1\n}')
  assert.equal(a.argValue({}, byKey('raw')), false)

  // A tool with no arguments has no fields — and neither does one whose
  // schema never arrived. Both read as "nothing to fill in".
  assert.deepEqual(a.argFieldsOf({ type: 'object', properties: {} }), [])
  assert.deepEqual(a.argFieldsOf(undefined), [])
  assert.deepEqual(a.parseArgs(''), {})
  assert.equal(a.parseArgs('[1,2]'), undefined, 'a JSON array is not a call argument object')
  assert.equal(a.parseArgs('{nope'), undefined)
})

/** The display fixture plus a started `alpha` that declares a real tool schema. */
function runFetch() {
  const tools = [{
    name: 'web_search_prime',
    description: 'Search the web.',
    inputSchema: {
      type: 'object',
      properties: {
        search_query: { type: 'string', description: 'What to search for.' },
        count: { type: 'integer', default: 10 },
        recency: { type: 'string', enum: ['oneDay', 'oneWeek'] },
      },
      required: ['search_query'],
    },
  }]
  return stubFetch((call) => {
    if (call.url.startsWith('/preview')) return { status: 200, json: displayDoc() }
    if (call.url.startsWith('/engine')) return { status: 200, json: { off: true } }
    if (/^\/mcp\/alpha\/ensure/.test(call.url)) return { status: 200, json: { name: 'alpha' } }
    if (/^\/mcp\/alpha\/status/.test(call.url)) return { status: 200, json: { lifecycle: 'started', state: 'up', type: 'echo' } }
    if (/^\/mcp\/alpha\/tools/.test(call.url)) return { status: 200, json: { tools, disabledTools: [] } }
    if (/^\/mcp\/alpha\/call/.test(call.url)) return { status: 200, json: { content: [{ type: 'text', text: 'ok' }] } }
    return { status: 500, json: { error: 'no route for ' + call.method + ' ' + call.url } }
  })
}

test('pages (run): the arguments come from the tool\'s own schema, not an empty {}', { skip: bundleSkipped }, async () => {
  // The complaint, as one test. The Run tab used to render ONE textarea
  // containing the two characters `{}`, while the tool list it had already
  // fetched carried a full JSON Schema for every tool.
  const mini = makeMiniReact()
  const calls = runFetch()
  const { registrations } = await loadClient(mini)
  const section = registrations.find((r) => r.slot === 'settings.section')
  mini.render(mini.createElement(section.component, { t: (key) => key }))
  await flush()
  await clickButton(mini, 'alpha')   // open the detail panel
  await clickButton(mini, 'run')     // its Run tab
  await flush()

  const fieldText = findClass(mini, 'mmc-field').map((f) => textOf(f))
  assert.ok(fieldText.length >= 3, 'one input per declared argument, got: ' + fieldText.join(' | '))
  assert.ok(fieldText.some((l) => l.includes('search_query') && l.includes('*')), 'the required argument is marked: ' + fieldText.join(' | '))
  assert.ok(fieldText.some((l) => l.includes('What to search for.')), 'the schema description is shown')
  assert.ok(fieldText.some((l) => l.includes('count')), 'every declared argument gets an input')
  assert.ok(fieldText.some((l) => l.includes('recency')), 'the enum argument has an input too')

  // Typing into a generated field builds the call; the request carries the
  // typed value under the schema's own key.
  const queryInput = findAll(mini.tree(), (el) => el.type === 'input' && el.props.placeholder === undefined)
    .find((n) => n.el.props.value === '')
  assert.ok(queryInput !== undefined, 'the string argument renders a text input')
  queryInput.el.props.onChange({ target: { value: 'dsh mcp' } })
  await flush()
  await clickButton(mini, 'runIt')
  const sent = calls.filter((c) => /\/mcp\/alpha\/call/.test(c.url))
  assert.equal(sent.length, 1, 'exactly one call sent')
  assert.equal(sent[0].body.tool, 'web_search_prime')
  assert.deepEqual(sent[0].body.arguments, { search_query: 'dsh mcp' },
    'the generated form produced the call, and sent no key the user did not fill')

  // The JSON view is still reachable — it is the escape hatch for a server
  // that under-declares — but it is no longer the only way in.
  assert.ok(findAll(mini.tree(), (el) => el.type === 'button' && textOfEl(el) === 'argsJson').length === 1)
})

/**
 * A call-log page EXACTLY as src/engine/calls.ts writes it.
 *
 * The point of copying the engine's field names literally is that the panel
 * had been reading `ts`, `source` and a string `preview` — none of which the
 * engine has ever sent. The client interface simply declared the guess, so
 * TypeScript compared the guess against itself and passed, the two columns
 * rendered blank, and `preview` (a BOOLEAN meaning "output is clipped") threw
 * `preview.slice is not a function` out of the render and took the whole
 * settings section down with it.
 */
function engineCallsPage() {
  return {
    name: 'alpha',
    page: 0,
    pageSize: 20,
    more: true,
    stderr: '',
    calls: [
      { seq: 12, at: '2026-09-07T02:43:09.978Z', tool: 'web_search_prime', via: 'mcp', client: 'default',
        // Stored the way an MCP text result actually is: JSON-encoded. Shown
        // as stored, a row starts with escaping rather than with a word.
        ok: true, ms: 431, args: '{"q":"x"}', output: JSON.stringify('the  reply\ntext'), chars: 9000, preview: true, body: true },
      // And the usual case: the engine clips a stored reply, so the JSON
      // string it came from has no closing quote left to parse.
      { seq: 11, at: '2026-09-07T02:41:00.000Z', tool: 'echo', via: 'panel',
        ok: false, ms: 12, args: '{}', output: '"[{\\"title\\":\\"a result that was cut', chars: 4000, preview: true },
    ],
  }
}

function callsFetch() {
  return stubFetch((call) => {
    if (call.url.startsWith('/preview')) return { status: 200, json: displayDoc() }
    if (call.url.startsWith('/engine')) return { status: 200, json: { off: true } }
    if (/^\/mcp\/alpha\/ensure/.test(call.url)) return { status: 200, json: { name: 'alpha' } }
    if (/^\/mcp\/alpha\/status/.test(call.url)) return { status: 200, json: { lifecycle: 'started', state: 'up', type: 'echo' } }
    if (/^\/mcp\/alpha\/call-sources/.test(call.url)) return { status: 200, json: { sources: [{ name: 'alpha', session: false }] } }
    if (/^\/mcp\/alpha\/calls/.test(call.url)) return { status: 200, json: engineCallsPage() }
    return { status: 500, json: { error: 'no route for ' + call.method + ' ' + call.url } }
  })
}

test('pages (calls): the log renders the ENGINE\'s fields, and a clipped reply does not crash the pane', { skip: bundleSkipped }, async () => {
  const mini = makeMiniReact()
  callsFetch()
  const { registrations } = await loadClient(mini)
  const section = registrations.find((r) => r.slot === 'settings.section')
  mini.render(mini.createElement(section.component, { t: (key) => key }))
  await flush()
  await clickButton(mini, 'alpha')
  await clickButton(mini, 'calls')
  await flush()
  assert.equal(mini.renderError(), null, 'rendering a real call page must not throw')

  const rows = findClass(mini, 'mmc-r').filter((r) => textOf(r).includes('web_search_prime') || textOf(r).includes('echo'))
  assert.equal(rows.length, 2, 'both log rows rendered')
  const first = textOf(rows.find((r) => textOf(r).includes('web_search_prime')))
  assert.ok(first.includes('02:43:09'), 'the timestamp comes from `at`: ' + first)
  assert.ok(first.includes('mcp'), 'the caller comes from `via`')
  assert.ok(first.includes('431ms'), 'duration shown')
  assert.ok(first.includes('the reply text'), 'the reply comes from `output`, decoded and whitespace-collapsed: ' + first)
  assert.ok(!first.includes('\\n') && !first.includes('\\"'), 'no escape sequence leaks into the row: ' + first)
  assert.ok(first.includes('9000'), 'a clipped reply says how much more there is')
  // The clipped one — the common case — is unescaped by hand, because there is
  // no closing quote left for JSON.parse to reach.
  const second = textOf(rows.find((r) => textOf(r).includes('echo')))
  assert.ok(second.includes('[{"title":"a result that was cut'), 'a clipped reply still reads as text: ' + second)
  assert.ok(!second.includes('\\"'), 'and carries no escape sequences: ' + second)

  // The pager follows `more`; the engine never counts a tail, so a total must
  // not be invented from one.
  const next = buttonsLabelled(mini.tree(), '›')[0]
  assert.ok(next !== undefined, 'a next-page control exists')
  assert.notEqual(next.el.props.disabled, true, 'more:true keeps the next page reachable')
})

test('css: a generated form clamps the server\'s prose instead of burying its inputs', () => {
  // A real search schema puts its whole enum listing in `description`. Six
  // lines of grey text per argument, in a 228px column, turned the Run tab
  // into a wall with 28px inputs hidden in it.
  assert.match(cssRule('.mmc-hint[data-clamp]'), /-webkit-line-clamp:2/, 'schema prose is clamped')
  assert.match(cssRule('.mmc-hint[data-clamp]'), /overflow:hidden/)
})

/**
 * The Run tab's past runs, with the engine's OWN history shape.
 *
 * `readToolHistory` (src/engine/calls.ts) answers `{seq, at, via, client?, ok,
 * ms, args}`, where `args` is a one-line preview CLIPPED at 96 characters. The
 * panel declared `{ts, args: unknown}` instead, so every row's name was blank
 * (there is no `ts`), its facts were `JSON.stringify` of a string — the escaped
 * quotes the user saw — and "reuse" wrote that quoted string into the argument
 * form, where it parsed as anything but an object and ran nothing. The search
 * the engine has always supported (`q`, matched against the FULL arguments) had
 * no control at all.
 */
function historyFetch() {
  const tools = [{
    name: 'web_search_prime',
    inputSchema: { type: 'object', properties: { search_query: { type: 'string' } }, required: ['search_query'] },
  }]
  const entries = [
    { seq: 12, at: '2026-09-07T02:43:09.978Z', via: 'panel', ok: true, ms: 431, args: '{"search_query":"rare_needle in a long argument set"}' },
    { seq: 9, at: '2026-09-07T02:20:00.000Z', via: 'mcp', client: 'Claude Code', ok: false, ms: 12, args: '{"search_query":"something else"}' },
  ]
  const seen = []
  const fetches = stubFetch((call) => {
    seen.push(call.url)
    if (call.url.startsWith('/preview')) return { status: 200, json: displayDoc() }
    if (call.url.startsWith('/engine')) return { status: 200, json: { off: true } }
    if (/^\/mcp\/alpha\/ensure/.test(call.url)) return { status: 200, json: { name: 'alpha' } }
    if (/^\/mcp\/alpha\/status/.test(call.url)) return { status: 200, json: { lifecycle: 'started', state: 'up', type: 'echo' } }
    if (/^\/mcp\/alpha\/tools/.test(call.url)) return { status: 200, json: { tools, disabledTools: [] } }
    // Ordered before /call: `/mcp/alpha/calls/12` starts with it too.
    if (/^\/mcp\/alpha\/calls\/12/.test(call.url)) {
      return { status: 200, json: { name: 'alpha', call: {
        seq: 12, at: '2026-09-07T02:43:09.978Z', tool: 'web_search_prime', via: 'panel', ok: true, ms: 431,
        args: '{"search_query":"rare_needle in a long argument set that the 96-char preview clipped"}',
        output: 'two results',
      } } }
    }
    if (/^\/mcp\/alpha\/history/.test(call.url)) {
      const q = new URLSearchParams(call.url.split('?')[1] ?? '').get('q') ?? ''
      const list = q === '' ? entries : entries.filter((e) => e.args.toLowerCase().includes(q.toLowerCase()))
      return { status: 200, json: { tool: 'web_search_prime', entries: list } }
    }
    if (/^\/mcp\/alpha\/call/.test(call.url)) return { status: 200, json: { content: [{ type: 'text', text: 'ok' }] } }
    return { status: 500, json: { error: 'no route for ' + call.method + ' ' + call.url } }
  })
  return { fetches, seen }
}

async function openRunHistory(mini) {
  const { registrations } = await loadClient(mini)
  const section = registrations.find((r) => r.slot === 'settings.section')
  mini.render(mini.createElement(section.component, { t: (key) => key }))
  await flush()
  await clickButton(mini, 'alpha')
  await clickButton(mini, 'run')
  await flush()
  await clickButton(mini, 'history')
  await flush()
}

test('pages (run history): past runs read as runs, and the search box is back', { skip: bundleSkipped }, async () => {
  const mini = makeMiniReact()
  const { seen } = historyFetch()
  await openRunHistory(mini)
  assert.equal(mini.renderError(), null)

  const rows = findClass(mini, 'mmc-r').filter((r) => textOf(r).includes('search_query'))
  assert.equal(rows.length, 2, 'both past runs listed')
  const first = textOf(rows[0])
  assert.ok(!first.includes('\\"'), 'the arguments are shown as themselves, not a JSON-quoted string: ' + first)
  assert.ok(first.includes('02:43:09'), 'when it ran comes from `at`: ' + first)
  assert.ok(first.includes('431ms'), 'how long it took')
  assert.ok(textOf(rows[1]).includes('Claude Code'), 'who ran it, when a client did')
  // The closed control says how much is behind it.
  assert.ok(buttonsLabelled(mini.tree(), 'histCount').length === 1, 'the control carries the count once loaded')

  // The filter is the SERVER's: it matches the full stored arguments, so a
  // keyword past the 96-character preview still finds its run.
  const box = findAll(mini.tree(), (el) => el.type === 'input' && el.props.placeholder === 'histSearch')[0]
  assert.ok(box !== undefined, 'the search box exists')
  box.el.props.onChange({ target: { value: 'rare_needle' } })
  await new Promise((resolve) => setTimeout(resolve, 260)) // debounced, one scan per pause
  await flush()
  assert.ok(seen.some((u) => /\/mcp\/alpha\/history\?.*q=rare_needle/.test(u)), 'the query went to the server: ' + seen.join(' '))
  assert.equal(findClass(mini, 'mmc-r').filter((r) => textOf(r).includes('search_query')).length, 1, 'the list narrowed')
})

test('pages (run history): reuse replays the FULL arguments, fetched by seq', { skip: bundleSkipped }, async () => {
  // The row label is clipped at 96 characters. Refilling the form from the
  // label would replay a truncated call, so the pick fetches the run.
  const mini = makeMiniReact()
  const { seen } = historyFetch()
  await openRunHistory(mini)
  await clickButton(mini, 'reuse')
  await flush()
  assert.equal(mini.renderError(), null)
  assert.ok(seen.some((u) => /\/mcp\/alpha\/calls\/12$/.test(u)), 'the full run was fetched by seq: ' + seen.join(' '))
  const filled = findAll(mini.tree(), (el) => el.type === 'input' && typeof el.props.value === 'string' && el.props.value.includes('clipped'))
  assert.equal(filled.length, 1, 'the generated form carries the whole stored argument, not the 96-char label')
})

test('css: the tab strip cannot be squeezed out of existence by a tall page', () => {
  // `.mmc-root` is a fixed-height flex COLUMN that scrolls. A flex item that
  // sets an overflow has its automatic minimum size resolve to 0, so the tab
  // strip (overflow:auto, so it can scroll in a narrow pane) was shrunk from
  // 28px to 4px the moment a sibling was taller than the pane — measured on a
  // live instance, on the Advanced tab. The strip vanished, and with it every
  // route back to the other tabs.
  assert.match(cssRule('.mmc-root>*'), /flex:0 0 auto/, 'nothing in the page body shrinks; the page scrolls')
  assert.match(cssRule('.mmc-root'), /overflow-wrap|display:flex/, 'the body really is the flex column this depends on')
})

test('pages (calls): an agent session\'s log is reachable, and is its own log', { skip: bundleSkipped }, async () => {
  // A DSH agent does not call the entry by name — the session plane ensures it
  // under a minted instance, and the call log follows the instance. The Calls
  // tab therefore read an empty log for an entry the workspace's agents had
  // been calling all day. The logs stay SEPARATE (each numbers its calls from
  // 1, and that number is how a call is opened), so the tab offers a choice.
  const session = 's16c53fd7df-1e1e2cdf91-alpha'
  const asked = []
  const mini = makeMiniReact()
  stubFetch((call) => {
    asked.push(call.url)
    if (call.url.startsWith('/preview')) return { status: 200, json: displayDoc() }
    if (call.url.startsWith('/engine')) return { status: 200, json: { off: true } }
    if (/^\/mcp\/alpha\/ensure/.test(call.url)) return { status: 200, json: { name: 'alpha' } }
    if (/^\/mcp\/alpha\/status/.test(call.url)) return { status: 200, json: { lifecycle: 'started', state: 'up', type: 'echo' } }
    if (/^\/mcp\/alpha\/call-sources/.test(call.url)) {
      return { status: 200, json: { sources: [
        { name: 'alpha', session: false, lastAt: '2026-09-07T01:00:00.000Z', lastSeq: 1 },
        { name: session, session: true, lastAt: '2026-09-07T03:30:00.000Z', lastSeq: 2 },
      ] } }
    }
    if (/^\/mcp\/alpha\/calls/.test(call.url)) return { status: 200, json: engineCallsPage() }
    if (new RegExp('^/mcp/' + session + '/calls').test(call.url)) {
      return { status: 200, json: { name: session, page: 0, more: false, calls: [
        { seq: 2, at: '2026-09-07T03:30:00.000Z', tool: 'web_search_prime', via: 'dsh-session', ok: true, ms: 900, args: '{}', output: 'from the agent' },
      ] } }
    }
    return { status: 500, json: { error: 'no route for ' + call.method + ' ' + call.url } }
  })
  const { registrations } = await loadClient(mini)
  const section = registrations.find((r) => r.slot === 'settings.section')
  mini.render(mini.createElement(section.component, { t: (key) => key }))
  await flush()
  await clickButton(mini, 'alpha')
  await clickButton(mini, 'calls')
  await flush()
  assert.equal(mini.renderError(), null)

  const chips = findAll(mini.tree(), (el) => el.type === 'button' && typeof textOfEl(el) === 'string' && /^source(Entry|Session)/.test(textOfEl(el)))
  assert.equal(chips.length, 2, 'one chip per log: ' + chips.map((c) => textOfEl(c.el)).join(' | '))
  const agent = chips.find((c) => textOfEl(c.el).startsWith('sourceSession'))
  assert.ok(agent !== undefined, 'the session log is offered')
  assert.ok(textOfEl(agent.el).includes('16c53f'), 'the chip names WHICH session, not just "a session"')
  assert.ok(wholeText(mini).includes('the reply text'), 'the entry\'s own log is what opens')

  agent.el.props.onClick()
  await flush()
  assert.ok(asked.some((u) => u.startsWith('/mcp/' + session + '/calls')), 'the session log was read: ' + asked.join(' '))
  assert.ok(wholeText(mini).includes('from the agent'), 'and it is what is shown now')
})

test('pages (tools): flipping one tool applies and shows, without blanking the pane', { skip: bundleSkipped }, async () => {
  // The switch used to bump the reload nonce BEFORE posting: the reload
  // re-read the list while the change was in flight (so it came back with the
  // old value and the switch snapped back), nothing bumped it again once the
  // post landed, and the reload starts with ensure() — a process spawn for a
  // stdio server. An empty pane and a switch that undoes itself: "it hangs".
  const asked = []
  const posted = []
  const mini = makeMiniReact()
  stubFetch((call) => {
    asked.push(call.method + ' ' + call.url)
    if (call.url.startsWith('/preview')) return { status: 200, json: displayDoc() }
    if (call.url.startsWith('/engine')) return { status: 200, json: { off: true } }
    if (/^\/mcp\/alpha\/ensure/.test(call.url)) return { status: 200, json: { name: 'alpha' } }
    // The detail keeps ONE payload for whichever tab it loaded; this fixture
    // carries the tool list in it, because the mini runtime runs an effect
    // once per mount and so never re-fires the tab-change reload.
    if (/^\/mcp\/alpha\/status/.test(call.url)) {
      return { status: 200, json: { lifecycle: 'started', state: 'up', type: 'proc',
        tools: [{ name: 'search', description: 'find things' }, { name: 'fetch' }], disabledTools: [] } }
    }
    if (/^\/mcp\/alpha\/setToolEnabled/.test(call.url)) {
      posted.push(call.body)
      // What the engine really answers (ipc-service.ts mcp.setToolEnabled).
      return { status: 200, json: { tool: call.body.tool, enabled: call.body.enabled, disabledTools: call.body.enabled === false ? [call.body.tool] : [] } }
    }
    if (/^\/mcp\/alpha\/tools/.test(call.url)) {
      return { status: 200, json: { tools: [{ name: 'search', description: 'find things' }, { name: 'fetch' }], disabledTools: [] } }
    }
    return { status: 500, json: { error: 'no route for ' + call.method + ' ' + call.url } }
  })
  const { registrations } = await loadClient(mini)
  const section = registrations.find((r) => r.slot === 'settings.section')
  mini.render(mini.createElement(section.component, { t: (key) => key }))
  await flush()
  await clickButton(mini, 'alpha')
  await clickButton(mini, 'tools')
  await flush()

  const sw = findAll(mini.tree(), (el) => el.type === 'button' && el.props.role === 'switch' && el.props['aria-label'] === 'search')
  assert.equal(sw.length, 1, 'the tool has one switch')
  assert.equal(sw[0].el.props['aria-checked'], 'true', 'it starts on')

  const before = asked.length
  sw[0].el.props.onClick()
  await flush()

  assert.deepEqual(posted, [{ tool: 'search', enabled: false }], 'exactly one apply, with the new value')
  const after = asked.slice(before)
  assert.equal(after.filter((u) => /\/ensure/.test(u)).length, 0, 'no re-ensure: ' + after.join(' | '))
  assert.equal(after.filter((u) => /\/tools/.test(u)).length, 0, 'no reload of the list either: ' + after.join(' | '))

  const now = findAll(mini.tree(), (el) => el.type === 'button' && el.props.role === 'switch' && el.props['aria-label'] === 'search')
  assert.equal(now[0].el.props['aria-checked'], 'false', 'the switch shows the engine\'s answer immediately')
  assert.ok(wholeText(mini).includes('find things'), 'and the list is still on screen, not blanked')
})

/**
 * A DOM small enough to be a fixture: the settings nav is three buttons, each
 * with the gear the shell drew.
 */
function fakeNav(labels) {
  const made = []
  const cell = (text) => {
    const attrs = {}
    const icon = {
      tag: 'svg', klass: 'VOzbGW_navIcon',
      getAttribute: (n) => (n === 'class' ? 'VOzbGW_navIcon' : null),
      // Adoption both ways: the mark learns which cell it went into, so the
      // restore path can be tested rather than assumed.
      replaceWith(next) { cell.icon = next; next.owner = cell },
    }
    const cell = {
      textContent: text,
      icon,
      getAttribute: (n) => (n in attrs ? attrs[n] : null),
      setAttribute: (n, v) => { attrs[n] = v },
      removeAttribute: (n) => { delete attrs[n] },
      querySelector: (sel) => (sel === 'svg' ? cell.icon : null),
    }
    return cell
  }
  const cells = labels.map(cell)
  return {
    cells,
    querySelectorAll: (sel) => {
      assert.equal(sel, '[role="dialog"] nav button', 'only the settings nav is ever touched')
      return cells
    },
    createElementNS: (ns, tag) => {
      const node = { ns, tag, attrs: {}, kids: [], replacedGear: null,
        setAttribute: (n, v) => { node.attrs[n] = v },
        appendChild: (c) => node.kids.push(c),
        replaceWith(next) { if (node.owner) node.owner.icon = next } }
      made.push(node)
      return node
    },
    made,
  }
}

test('nav icon: the gear on OUR row becomes an MCP mark, and only ours', async () => {
  const mod = await import('../src/client/nav-icon.ts')
  const doc = fakeNav(['Models', 'MCP & Connections', 'Plugins'])
  const stop = mod.paintNavIcon(() => 'MCP & Connections', doc)

  const [models, ours, plugins] = doc.cells
  assert.equal(models.icon.tag, 'svg', 'another section keeps the shell\'s own icon')
  assert.equal(plugins.icon.tag, 'svg')
  assert.equal(doc.made.length, 1 + mod.MCP_MARK.paths.length, 'one svg plus its paths, built once')
  assert.equal(ours.icon.attrs.viewBox, mod.MCP_MARK.viewBox)
  assert.equal(ours.icon.attrs.fill, 'currentColor', 'it inherits the nav\'s colour like its neighbours')
  assert.equal(ours.icon.attrs.stroke, undefined, 'the logo is a filled outline; stroking it would double every edge')
  assert.equal(ours.icon.attrs.class, 'VOzbGW_navIcon', 'and the shell\'s own layout class')
  assert.equal(ours.icon.kids.length, mod.MCP_MARK.paths.length, 'every subpath of the mark')

  // Painting again must not paint again: the pass runs on every DOM mutation,
  // and setting the marker attribute is itself one.
  mod.paintNavIcon(() => 'MCP & Connections', doc)
  assert.equal(doc.made.length, 1 + mod.MCP_MARK.paths.length, 'the second pass is a no-op')

  const mark = ours.icon
  stop()
  assert.notEqual(ours.icon, mark, 'dispose puts back the icon the shell drew')
  assert.equal(ours.icon.tag, 'svg')
  assert.equal(ours.icon.getAttribute('class'), 'VOzbGW_navIcon')
  assert.equal(ours.getAttribute('data-mmc-nav-icon'), null, 'and forgets it painted')
})

test('nav icon: a label that matches nothing changes nothing', async () => {
  const mod = await import('../src/client/nav-icon.ts')
  const doc = fakeNav(['Models', 'Plugins'])
  mod.paintNavIcon(() => 'MCP & Connections', doc)
  assert.equal(doc.made.length, 0, 'no row claimed; the shell keeps its gear')
  mod.paintNavIcon(() => '', doc)
  assert.equal(doc.made.length, 0, 'an unresolved label paints nothing at all')
})

test('pages (tools): a tool that is OFF still has a row, so it can be turned back on', { skip: bundleSkipped }, async () => {
  // Disabling a tool removes it from the SERVED list — that is what disabling
  // does — and the engine names it separately in `disabledTools` for exactly
  // this reason. Rendering only the served list made the switch one-way: the
  // row vanished, and with it the only way back on.
  const posted = []
  const mini = makeMiniReact()
  // The detail pane loads once per instance in this harness (effects ignore
  // deps), so the tab's payload rides on the status fixture — as in the
  // toggle test above.
  const listing = { tools: [{ name: 'search', description: 'find things' }], disabledTools: ['fetch'] }
  stubFetch((call) => {
    if (call.url.startsWith('/preview')) return { status: 200, json: displayDoc() }
    if (call.url.startsWith('/engine')) return { status: 200, json: { off: true } }
    if (/^\/mcp\/alpha\/ensure/.test(call.url)) return { status: 200, json: { name: 'alpha' } }
    if (/^\/mcp\/alpha\/setToolEnabled/.test(call.url)) {
      posted.push(call.body)
      return { status: 200, json: { tool: call.body.tool, enabled: call.body.enabled, disabledTools: [] } }
    }
    if (/^\/mcp\/alpha\/status/.test(call.url)) {
      return { status: 200, json: { lifecycle: 'started', state: 'up', type: 'proc', ...listing } }
    }
    if (/^\/mcp\/alpha\/tools/.test(call.url)) return { status: 200, json: listing }
    return { status: 500, json: { error: 'no route for ' + call.method + ' ' + call.url } }
  })
  const { registrations } = await loadClient(mini)
  const section = registrations.find((r) => r.slot === 'settings.section')
  mini.render(mini.createElement(section.component, { t: (key) => key }))
  await flush()
  await clickButton(mini, 'alpha')
  await clickButton(mini, 'tools')
  await flush()

  const switches = (label) => findAll(mini.tree(),
    (el) => el.type === 'button' && el.props.role === 'switch' && el.props['aria-label'] === label)
  const off = switches('fetch')
  assert.equal(off.length, 1, 'the disabled tool still has a row')
  assert.equal(off[0].el.props['aria-checked'], 'false', 'shown as off')
  assert.equal(switches('search')[0].el.props['aria-checked'], 'true', 'and the served one is still on')

  off[0].el.props.onClick()
  await flush()
  assert.deepEqual(posted, [{ tool: 'fetch', enabled: true }], 'clicking it asks to turn it back ON')
  assert.equal(switches('fetch')[0].el.props['aria-checked'], 'true', 'and the switch shows the engine answered')
})

test('pages (run): the reply is shown as text, not as its own transport', { skip: bundleSkipped }, async () => {
  // What the box used to print for a URL reader:
  //   [ { "type": "text", "text": "\"{\\\"title\\\"..." } ]
  // The reply arrives ALREADY string-encoded (a text block whose text is a
  // JSON string literal), and JSON.stringify put another layer on top, so a
  // document read `\\\\n` between every line.
  const inner = JSON.stringify({ title: 'Example Domain', content: 'first line\nsecond line' })
  const wire = JSON.stringify(inner) // the double encoding the server really sends
  const mini = makeMiniReact()
  stubFetch((call) => {
    if (call.url.startsWith('/preview')) return { status: 200, json: displayDoc() }
    if (call.url.startsWith('/engine')) return { status: 200, json: { off: true } }
    if (/^\/mcp\/alpha\/ensure/.test(call.url)) return { status: 200, json: { name: 'alpha' } }
    if (/^\/mcp\/alpha\/status/.test(call.url)) return { status: 200, json: { lifecycle: 'started', state: 'up', type: 'http' } }
    if (/^\/mcp\/alpha\/tools/.test(call.url)) {
      return { status: 200, json: { tools: [{ name: 'webReader', inputSchema: { type: 'object', properties: {} } }], disabledTools: [] } }
    }
    if (/^\/mcp\/alpha\/call/.test(call.url)) {
      return { status: 200, json: { ok: true, isError: false, ms: 12, content: [{ type: 'text', text: wire }] } }
    }
    return { status: 500, json: { error: 'no route for ' + call.method + ' ' + call.url } }
  })
  const { registrations } = await loadClient(mini)
  const section = registrations.find((r) => r.slot === 'settings.section')
  mini.render(mini.createElement(section.component, { t: (key) => key }))
  await flush()
  await clickButton(mini, 'alpha')
  await clickButton(mini, 'run')
  await flush()
  await clickButton(mini, 'runIt')
  await flush()

  const shown = wholeText(mini)
  // Decoded once, then pretty-printed because what is left IS JSON.
  assert.ok(shown.includes('"title": "Example Domain"'), 'the reply reads as JSON, not as an escaped string: ' + shown.slice(-300))
  assert.ok(!shown.includes('"type": "text"'), 'the content envelope is not part of the reply')
  // Two backslashes followed by n: one re-encoding too many, and the whole
  // complaint. (Four in this source string is JS escaping of two.)
  assert.ok(!shown.includes('\\\\n'), 'nothing is escaped twice: ' + shown.slice(-300))
})

test('pages (run): a reply that is plain text stays plain, and a binary block is described', { skip: bundleSkipped }, async () => {
  const mini = makeMiniReact()
  stubFetch((call) => {
    if (call.url.startsWith('/preview')) return { status: 200, json: displayDoc() }
    if (call.url.startsWith('/engine')) return { status: 200, json: { off: true } }
    if (/^\/mcp\/alpha\/ensure/.test(call.url)) return { status: 200, json: { name: 'alpha' } }
    if (/^\/mcp\/alpha\/status/.test(call.url)) return { status: 200, json: { lifecycle: 'started', state: 'up', type: 'http' } }
    if (/^\/mcp\/alpha\/tools/.test(call.url)) {
      return { status: 200, json: { tools: [{ name: 'shot', inputSchema: { type: 'object', properties: {} } }], disabledTools: [] } }
    }
    if (/^\/mcp\/alpha\/call/.test(call.url)) {
      return { status: 200, json: { content: [
        { type: 'text', text: 'plain words, nothing encoded' },
        { type: 'image', mimeType: 'image/png', data: 'A'.repeat(4096) },
      ] } }
    }
    return { status: 500, json: { error: 'no route for ' + call.method + ' ' + call.url } }
  })
  const { registrations } = await loadClient(mini)
  const section = registrations.find((r) => r.slot === 'settings.section')
  mini.render(mini.createElement(section.component, { t: (key) => key }))
  await flush()
  await clickButton(mini, 'alpha')
  await clickButton(mini, 'run')
  await flush()
  await clickButton(mini, 'runIt')
  await flush()

  const shown = wholeText(mini)
  assert.ok(shown.includes('plain words, nothing encoded'), 'text that was never encoded is left alone')
  assert.ok(shown.includes('[image image/png, 3 KB]'), 'a base64 payload is described, not pasted: ' + shown.slice(-200))
  assert.ok(!shown.includes('AAAAAAAA'), 'the base64 itself never reaches the box')
})

test('pages (calls): an expanded call is laid out, not dumped as JSON', { skip: bundleSkipped }, async () => {
  // It used to be JSON.stringify of the whole record: the three things a
  // reader wants — when, what went in, what came back — inside a transport
  // dump, with the arguments escaped a SECOND time because they are stored as
  // a JSON string.
  const args = JSON.stringify({ search_query: '人工智能 最新消息', content_size: 'medium' })
  const output = JSON.stringify(JSON.stringify([{ title: '量子位', link: 'https://example.com' }]))
  const mini = makeMiniReact()
  stubFetch((call) => {
    if (call.url.startsWith('/preview')) return { status: 200, json: displayDoc() }
    if (call.url.startsWith('/engine')) return { status: 200, json: { off: true } }
    if (/^\/mcp\/alpha\/ensure/.test(call.url)) return { status: 200, json: { name: 'alpha' } }
    if (/^\/mcp\/alpha\/status/.test(call.url)) return { status: 200, json: { lifecycle: 'started', state: 'up', type: 'http' } }
    if (/^\/mcp\/alpha\/call-sources/.test(call.url)) return { status: 200, json: { sources: [{ name: 'alpha', session: false }] } }
    if (/^\/mcp\/alpha\/calls\/4$/.test(call.url)) {
      return { status: 200, json: { call: {
        seq: 4, at: '2026-09-07T09:34:27.691Z', tool: 'web_search_prime', via: 'dsh-session',
        ok: true, ms: 2087, args, output, chars: 2307, preview: true,
      } } }
    }
    if (/^\/mcp\/alpha\/calls/.test(call.url)) {
      return { status: 200, json: { name: 'alpha', page: 0, calls: [
        { seq: 4, at: '2026-09-07T09:34:27.691Z', tool: 'web_search_prime', via: 'dsh-session', ok: true, ms: 2087, args, output, chars: 2307, preview: true },
      ] } }
    }
    return { status: 500, json: { error: 'no route for ' + call.method + ' ' + call.url } }
  })
  const { registrations } = await loadClient(mini)
  const section = registrations.find((r) => r.slot === 'settings.section')
  mini.render(mini.createElement(section.component, { t: (key) => key }))
  await flush()
  await clickButton(mini, 'alpha')
  await clickButton(mini, 'calls')
  await flush()

  const row = findAll(mini.tree(), (el) => el.type === 'button' && el.props.className === 'mmc-open' && el.props['aria-label'] === 'web_search_prime')
  assert.ok(row.length >= 1, 'the call row is there to open')
  row[0].el.props.onClick()
  await flush()

  const shown = wholeText(mini)
  assert.ok(shown.includes('"search_query": "人工智能 最新消息"'), 'the arguments read as JSON, decoded once: ' + shown.slice(-400))
  assert.ok(!shown.includes('\\"search_query\\"'), 'and are not escaped a second time')
  assert.ok(shown.includes('"title": "量子位"'), 'the reply is decoded too')
  assert.ok(shown.includes('2087'), 'the facts are still there')
  assert.ok(shown.includes('2307'), 'including that the stored reply is only the head')
})

test('workspace dropdown: compact labels, searchable paths/IDs, keyboard selection, IME and escape', { skip: bundleSkipped }, async () => {
  const mini = makeMiniReact()
  const items = [
    { id: 'uuid-one-long', title: 'swiss', path: 'C:/projects/swiss' },
    { id: 'uuid-two-long', path: 'C:/projects/rustdesk' },
  ]
  stubFetch((call) => {
    if (call.url.startsWith('/workspaces')) return { status: 200, json: { items } }
    if (call.url.startsWith('/preview')) return { status: 200, json: previewDoc() }
    if (call.url.startsWith('/engine')) return { status: 200, json: { off: true } }
    return { status: 500, json: { error: 'no route' } }
  })
  const { registrations } = await loadClient(mini)
  mini.render(mini.createElement(registrations.find((r) => r.slot === 'settings.section').component, { t: (key) => key }))
  await flush()
  const trigger = () => findAll(mini.tree(), (el) => el.props.className === 'mmc-ws-trigger')[0]
  trigger().el.props.onClick()
  await flush()
  const options = () => findAll(mini.tree(), (el) => el.props.role === 'option')
  const search = () => findAll(mini.tree(), (el) => el.props.role === 'combobox')[0]
  assert.equal(options().length, 3, 'global and two projects')
  assert.ok(findText(mini, 'rustdesk'), 'missing title falls back to basename, not UUID')
  assert.ok(!wholeText(mini).includes('uuid-one-long'), 'full UUID is not visible noise')
  assert.ok(options()[1].el.props.title.includes('uuid-one-long'), 'identity remains available in tooltip')
  search().el.props.onChange({ target: { value: 'projects/rust' } })
  await flush()
  assert.equal(options().length, 1)
  const key = (name, extra = {}) => ({ key: name, preventDefault() {}, stopPropagation() {}, ...extra })
  search().el.props.onKeyDown(key('Enter', { isComposing: true }))
  await flush()
  assert.equal(trigger().el.props['aria-expanded'], 'true', 'IME Enter does not select')
  search().el.props.onKeyDown(key('Enter'))
  await flush()
  assert.ok(textOf(trigger()).includes('rustdesk'))
  assert.equal(trigger().el.props['aria-expanded'], 'false')
  trigger().el.props.onKeyDown(key('ArrowDown'))
  await flush()
  search().el.props.onChange({ target: { value: 'uuid-one' } })
  await flush()
  assert.equal(options().length, 1, 'ID is searchable without displaying it')
  let stopped = false
  search().el.props.onKeyDown(key('Escape', { stopPropagation() { stopped = true } }))
  await flush()
  assert.equal(stopped, true, 'escape only dismisses picker, not settings modal')
  assert.ok(textOf(trigger()).includes('rustdesk'), 'escape does not change selection')
  trigger().el.props.onClick()
  await flush()
  search().el.props.onChange({ target: { value: 'no-such-workspace' } })
  await flush()
  assert.equal(options().length, 0)
  assert.ok(findText(mini, 'workspaceNoMatches'))
  search().el.props.onKeyDown(key('Tab'))
  await flush()
  assert.equal(trigger().el.props['aria-expanded'], 'false', 'Tab closes without changing value')
  assert.equal(mini.renderError(), null)
})

test('Add MCP opens Claude layer editor and saves with captured source and revision', { skip: bundleSkipped }, async () => {
  const mini = makeMiniReact()
  const doc = previewDoc()
  doc.layers.push({ level: 'global', source: 'standard', layerId: 'global:claude', label: 'HOST-PATH/.claude/.mcp.json', exists: false, revision: '' })
  const calls = stubFetch((call) => {
    if (call.url.startsWith('/preview')) return { status: 200, json: doc }
    if (call.url.startsWith('/engine')) return { status: 200, json: { off: true } }
    if (call.url.startsWith('/entry')) return { status: 200, json: { revision: 'new' } }
    return { status: 500, json: { error: 'no route' } }
  })
  const { registrations } = await loadClient(mini)
  mini.render(mini.createElement(registrations.find((r) => r.slot === 'settings.section').component, { t: (key) => key }))
  await flush()
  await clickButton(mini, 'addMcp')
  await clickButton(mini, 'layerGlobalClaude')
  const label = findAll(mini.tree(), (el) => el.type === 'label').find((node) => textOf(node).trim() === 'name')
  const name = findAll(label, (el) => el.type === 'input')[0]
  assert.ok(name, 'new entry name field appears')
  name.el.props.onChange({ target: { value: 'new-server' } })
  await flush()
  await clickButton(mini, 'jsonTab')
  textareas(mini)[0].el.props.onChange({ target: { value: JSON.stringify({ command: 'node', args: ['server.mjs'] }) } })
  await flush()
  await clickButton(mini, 'save')
  const saves = calls.filter((c) => c.url.startsWith('/entry'))
  assert.equal(saves.length, 1)
  assert.deepEqual(saves[0].body, { layerId: 'global:claude', level: 'global', source: 'standard', name: 'new-server', def: { command: 'node', args: ['server.mjs'] }, expectedRevision: '' })
  assert.equal(mini.renderError(), null)
})

test('client bundle registers under the package name the loader discovered (id contract)', () => {
  // The dsh client-modules contract keys the bundle registration on the
  // package name (manifest.ts: "Plugin id (package name) — the registration
  // key; must match the graph row being executed"). A hardcoded id broke the
  // settings panel on the 0.3.2 rename while the host half kept working;
  // this guard makes that drift fail CI instead of a browser banner.
  const name = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).name
  const bundle = readFileSync(join(here, '..', 'dist', 'client.js'), 'utf8')
  assert.ok(bundle.includes(`id: ${JSON.stringify(name)}`), `bundle must load() under the package name ${name}`)
  // esbuild leaves the define as a folded template interpolation; the
  // injected string must sit inside the style-ownership selector.
  assert.ok(bundle.includes(`style[data-plugin-css="\${${JSON.stringify(name)}}"]`), 'style ownership selector must use the same id')
  assert.ok(bundle.split(JSON.stringify(name)).length >= 4, 'id must reach every site (load, selector, two datasets)')
  assert.ok(!bundle.includes('dsh-mcp-json-adapter'), 'no stale pre-rename id may remain in the bundle')
})
