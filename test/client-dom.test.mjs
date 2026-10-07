/** Real React commit/ref/focus tests: the mini renderer cannot catch these failures. */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://127.0.0.1:3080' })
for (const key of ['window', 'document', 'Node', 'HTMLElement']) globalThis[key] = dom.window[key]
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const React = await import('react')
const { createRoot } = await import('react-dom/client')
const { createPortal } = await import('react-dom')
const { kit } = await import('../dist/client/ui.js')
const { makeWorkspacePicker } = await import('../dist/client/pages/workspace-picker.js')
const { makeMcpWorkbench } = await import('../dist/client/pages/mcp.js')
const h = React.createElement, { act } = React
after(() => dom.window.close())
const host = {
  createPortal,
  MenuSurface: React.forwardRef((props, ref) => h('div', { ...props, ref })),
  Input: React.forwardRef(({ icon, className, ...props }, ref) => h('span', { className }, icon, h('input', { ...props, ref }))),
}
async function render(t, element) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  t.after(async () => { await act(async () => root.unmount()); container.remove() })
  await act(async () => { root.render(element) })
  return container
}

for (const [name, deps] of [['inline fallback', {}], ['shell input + portaled surface', host]]) {
  test('workspace DOM: ' + name + ' stays open, focuses search after refs attach, dismisses outside', async (t) => {
    const Picker = makeWorkspacePicker(React, kit(React), deps)
    await render(t, h(Picker, { t: (key) => key, value: '', items: [{ id: 'ws', path: 'C:/projects/swiss', title: 'swiss' }], onChange: () => {} }))
    const trigger = document.querySelector('.mmc-ws-trigger')
    await act(async () => trigger.click())
    assert.equal(trigger.getAttribute('aria-expanded'), 'true', 'autofocus must not close popup before parent ref attaches')
    const input = document.querySelector('[role=combobox]')
    assert.equal(document.activeElement, input, 'search owns focus after commit, without scrolling the modal')
    assert.equal(document.querySelectorAll('[role=option]').length, 2)
    await act(async () => document.body.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true })))
    assert.equal(trigger.getAttribute('aria-expanded'), 'false')
    assert.equal(document.querySelector('.mmc-ws-popup'), null)
  })
}

for (const shiftKey of [false, true]) {
  test('workspace DOM: portaled ' + (shiftKey ? 'Shift+Tab' : 'Tab') + ' returns to trigger before modal trap', async (t) => {
    const Picker = makeWorkspacePicker(React, kit(React), host)
    const container = await render(t, h('div', { role: 'dialog' }, h('button', {}, 'close'), h(Picker, { t: (key) => key, value: '', items: [], onChange: () => {} }), h('button', {}, 'next')))
    let trapSaw
    // Installed DSH useModalLayer allows default Tab only when focus is inside
    // the modal and not at its edge. A body-portal combobox used to fail this.
    const modalTrap = (event) => {
      if (event.key !== 'Tab') return
      const dialog = container.querySelector('[role=dialog]')
      trapSaw = document.activeElement
      if (!dialog.contains(trapSaw)) event.preventDefault()
    }
    document.addEventListener('keydown', modalTrap)
    t.after(() => document.removeEventListener('keydown', modalTrap))
    const trigger = container.querySelector('.mmc-ws-trigger')
    await act(async () => trigger.click())
    const input = document.querySelector('[role=combobox]')
    const event = new dom.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true })
    await act(async () => input.dispatchEvent(event))
    assert.equal(trapSaw, trigger, 'modal trap sees the anchor, not a disconnected body popup')
    assert.equal(event.defaultPrevented, false, 'native Tab can continue to the adjacent dialog control')
    assert.equal(trigger.getAttribute('aria-expanded'), 'false')
  })
}

for (const selector of ['.mmc-target-label', '.mmc-tag', '.mmc-chev']) {
  test('Add MCP DOM: clicking destination ' + selector + ' enters editor, not dead decoration', async (t) => {
    t.mock.method(globalThis, 'fetch', async (url) => {
      const path = String(url)
      const data = path.includes('/preview') ? { level: 'global', layers: [{ layerId: 'global:standard', level: 'global', source: 'standard', exists: false, label: 'fixture', revision: '' }], entries: [], conflicts: [], problems: [] } : path.includes('/workspaces') ? { items: [] } : { off: true }
      return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } })
    })
    const Pane = makeMcpWorkbench(React, kit(React), host)
    const container = await render(t, h(Pane, { t: (key) => key }))
    await act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'addMcp').click())
    const target = container.querySelector('.mmc-target')
    assert.ok(target, 'full-width destination button rendered')
    await act(async () => target.querySelector(selector).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.equal(container.querySelector('.mmc-target'), null, 'destination chooser closed')
    assert.ok(container.querySelector('label input'), 'new MCP editor name field is visible')
    assert.ok([...container.querySelectorAll('button')].some((b) => b.textContent === 'save'), 'save action available')
  })
}

const { makeEntryEditor } = await import('../dist/client/pages/entry-editor.js')
function editorArgs(extra = {}) {
  return { t: (key) => key, mode: 'create', name: '', initial: '{}', level: 'global', source: 'standard', layerId: 'global:standard', revision: 'captured-r1', onCancel: () => {}, onSaved: () => {}, onRevision: () => {}, ...extra }
}
async function fill(element, value) {
  const prototype = element.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value)
    element.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}
const button = (container, text) => [...container.querySelectorAll('button')].find((b) => b.textContent === text)

for (const source of ['standard', 'native', 'session']) {
  const layerId = source === 'session' ? 'session:overrides' : 'global:' + source
  const scope = { source, layerId, ...(source === 'session' ? { level: 'session', ss: 'fixture-ss' } : {}) }
  test('editor DOM: pasted mcpServers HTTP fills first name/headers and saves to captured ' + source + ' layer', async (t) => {
    const requests = []
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) })
      return new Response(JSON.stringify({ revision: 'r2' }), { headers: { 'content-type': 'application/json' } })
    })
    const Editor = makeEntryEditor(React, kit(React))
    const container = await render(t, h(Editor, { args: editorArgs(scope) }))
    await act(async () => button(container, 'jsonTab').click())
    const http = { type: 'http', url: 'https://example.invalid/mcp/mongo', headers: { Authorization: 'Bearer fixture-only' }, custom: { preserved: true } }
    await fill(container.querySelector('textarea'), JSON.stringify({ mcpServers: { mongo: http, ignored: { command: 'ignored' } } }))
    assert.equal(container.querySelector('.mmc-editor-name-label input').value, 'mongo')
    assert.equal(JSON.parse(container.querySelector('textarea').value).url, http.url, 'wrapper was replaced with ONLY its first definition')
    assert.equal(button(container, 'save').disabled, false)
    await act(async () => button(container, 'formTab').click())
    assert.equal(container.querySelector('select').value, source === 'standard' ? 'remote' : 'http')
    assert.ok([...container.querySelectorAll('.mmc-field label')].every((label) => label.control !== null), 'every text field is associated with its label')
    await act(async () => button(container, 'save').click())
    assert.equal(requests.length, 1, 'saving never refreshes preview or probes a live endpoint')
    assert.equal(requests[0].body.name, 'mongo')
    assert.equal(requests[0].body.layerId, layerId)
    assert.equal(requests[0].body.expectedRevision, 'captured-r1')
    assert.deepEqual(requests[0].body.def, http, 'URL, Authorization and unknown fields remain intact')
  })
}

for (const source of ['native', 'session']) {
test('editor DOM: typed stdio JSON becomes runnable proc and auto-fills name for ' + source, async (t) => {
  let saved
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    saved = JSON.parse(init.body)
    return new Response(JSON.stringify({ revision: 'r2' }), { headers: { 'content-type': 'application/json' } })
  })
  const Editor = makeEntryEditor(React, kit(React))
  const container = await render(t, h(Editor, { args: editorArgs({ source, layerId: source === 'session' ? 'session:overrides' : 'global:native', ...(source === 'session' ? { level: 'session', ss: 'fixture-ss' } : {}) }) }))
  await act(async () => button(container, 'jsonTab').click())
  await fill(container.querySelector('textarea'), JSON.stringify({ mcpServers: { local: { type: 'stdio', command: 'node', args: ['my server.mjs', 'a"b'], env: { TOKEN: 'fixture-only' } } } }))
  await act(async () => button(container, 'save').click())
  const { tokenizeCommand } = await import('../dist/engine/adapters/proc.js')
  assert.equal(saved.name, 'local')
  assert.equal(saved.def.type, 'proc')
  assert.deepEqual(tokenizeCommand(saved.def.command), ['node', 'my server.mjs', 'a"b'])
  assert.deepEqual(saved.def.env, { TOKEN: 'fixture-only' })
  assert.equal(Object.hasOwn(saved.def, 'args'), false)
})
}

test('editor DOM: folding advanced fields retains masked secrets and unknown options on save', async (t) => {
  let saved
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    saved = JSON.parse(init.body)
    return new Response(JSON.stringify({ revision: 'r2' }), { headers: { 'content-type': 'application/json' } })
  })
  const def = { command: 'node', args: ['server.mjs'], env: { TOKEN: '••••••••' }, cwd: '/tmp/work', custom: 42 }
  const Editor = makeEntryEditor(React, kit(React))
  const container = await render(t, h(Editor, { args: editorArgs({ mode: 'edit', name: 'local', initial: JSON.stringify(def) }) }))
  const advanced = container.querySelector('details')
  assert.equal(advanced.open, true, 'configured optional fields are not initially hidden')
  await act(async () => { advanced.open = false; advanced.dispatchEvent(new dom.window.Event('toggle')) })
  await act(async () => button(container, 'save').click())
  assert.deepEqual(saved.def, def)
  assert.equal(saved.expectedRevision, 'captured-r1')
})

test('editor DOM: explicit conflict reload refreshes revision without losing draft or stale useCallback closure', async (t) => {
  const saves = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).includes('/preview')) return new Response(JSON.stringify({ layers: [{ layerId: 'global:standard', level: 'global', source: 'standard', revision: 'r2' }] }), { headers: { 'content-type': 'application/json' } })
    saves.push(JSON.parse(init.body))
    return new Response(JSON.stringify(saves.length === 1 ? { error: 'changed layer' } : { revision: 'r3' }), { status: saves.length === 1 ? 409 : 200, headers: { 'content-type': 'application/json' } })
  })
  const Editor = makeEntryEditor(React, kit(React))
  function Host() {
    const [revision, onRevision] = React.useState('r1')
    return h(Editor, { args: editorArgs({ mode: 'edit', name: 'local', initial: '{"command":"node server.mjs"}', revision, onRevision }) })
  }
  const container = await render(t, h(Host))
  await act(async () => button(container, 'save').click())
  await act(async () => button(container, 'reloadLayerKeepDraft').click())
  await act(async () => button(container, 'save').click())
  assert.deepEqual(saves.map((b) => b.expectedRevision), ['r1', 'r2'])
  assert.deepEqual(saves[1].def, saves[0].def, 'explicit reload keeps the JSON draft')
})
