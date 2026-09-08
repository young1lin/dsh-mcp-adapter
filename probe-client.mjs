// fetch the EXACT bundle the browser gets, then evaluate it in a fake window
const bundleUrl = 'http://127.0.0.1:3080/plugins/dsh-mcp-json-adapter/client.js?rev=ac55d2545cd5'
const src = await (await fetch(bundleUrl)).text()
console.log('bundle bytes:', src.length)
const loads = []
const registrations = []
const effects = []
const window = {
  __ModuleLoader__: {
    load: (spec) => { loads.push(spec.id); spec.factory((id) => {
      if (id === 'react') return { createElement: (t, p, ...c) => ({ t, p, c }), useState: (v) => [v, () => {}], useEffect: () => {}, useCallback: (f) => f, useSyncExternalStore: (s, g) => g() }
      throw new Error('unexpected require: ' + id)
    }) },
  },
  document: undefined,
}
globalThis.window = window
try {
  const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'))
  console.log('module evaluated OK; loads:', loads.join(','))
  // The load() call happens at eval; grab the returned module exports and run apply
} catch (e) {
  console.log('EVAL THREW:', e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n') : String(e))
}