/** Isolated visual fixture of the real workbench; no live config, auth or engine mutation. */
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { createPortal } from 'react-dom'
import { kit, css } from '../src/client/ui.ts'
import { makeMcpWorkbench } from '../src/client/pages/mcp.ts'
import { en } from '../src/client/i18n.ts'
const h = React.createElement
const style = document.createElement('style')
style.textContent = css + `
:root{--dsw-alias-label-primary:#1d1d1f;--dsw-alias-label-secondary:#6e6e73;--dsw-alias-label-tertiary:#8e8e93;--dsw-alias-bg-base:#fff;--dsw-alias-bg-layer-1:#fff;--dsw-alias-interactive-bg-hover:#f0f0f2;--dsw-alias-border-l4:#d2d2d7;--dsw-menu-surface-fill:#fff;--dsw-radius-sm:8px;--dsw-radius-md:12px;--dsw-radius-lg:16px}
body{margin:0;background:#e7e7e9;font-family:system-ui,sans-serif;font-size:14px}.fixture-dialog{position:fixed;inset:24px;z-index:1000;background:white;border-radius:20px;padding:24px;box-shadow:0 8px 32px #0002;display:flex;flex-direction:column}.fixture-head{display:flex;justify-content:space-between;align-items:center;font-size:18px;font-weight:600;margin-bottom:24px}.fixture-body{display:flex;flex:1;min-height:0}.fixture-side{width:190px;padding:12px 24px 0 0;line-height:44px;flex:none}.fixture-main{flex:1;min-width:0;overflow:auto}button{font-family:inherit}.fixture-side b{background:#edeef1;border-radius:10px;padding:12px}.fixture-head button{background:none;border:0;cursor:pointer;font-size:20px}
`
document.head.appendChild(style)
const doc = { level: 'global', layers: [
  { layerId: 'global:claude', level: 'global', source: 'standard', label: '~/.claude/.mcp.json', exists: false, revision: '' },
  { layerId: 'global:standard', level: 'global', source: 'standard', label: '~/.agents/.mcp.json', exists: true, revision: 'fixture-r1' },
  { layerId: 'global:native', level: 'global', source: 'native', label: 'native:global', exists: true, revision: 'fixture-r2' },
], entries: ['zhipu-reader', 'zhipu-search', 'zhipu-vision', 'zhipu-zread'].map((name) => ({ name, level: 'global', source: 'native', layerId: 'global:native', revision: 'fixture-r2', def: { type: 'http', url: 'https://example.invalid/mcp' }, disabled: false, inherited: false, overrides: [] })), conflicts: [], problems: [] }
const items = ['swiss', 'rustdesk', 'dsh-mcp-adapter'].map((title) => ({ id: 'fixture-' + title, title, path: 'C:/PythonProject/dev/' + title }))
window.fetch = async (url) => {
  const path = String(url)
  const body = path.includes('/workspaces') ? { items } : path.includes('/preview') ? doc : path.includes('/view') ? { version: 1, entries: {}, groups: [] } : path.includes('/engine') ? { off: true } : { revision: 'fixture-saved' }
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
}
// Shell MenuSurface paints a material child; this stand-in supplies its fill
// explicitly so the visual fixture does not accidentally become transparent.
const MenuSurface = React.forwardRef(({ style, ...props }, ref) => h('div', { ...props, ref, style: { ...style, background: 'var(--dsw-menu-surface-fill,#fff)' } }))
const Input = React.forwardRef(({ icon, className, ...props }, ref) => h('span', { className }, icon, h('input', { ...props, ref, className: 'mmc-ws-search-input' })))
const Pane = makeMcpWorkbench(React, kit(React), { createPortal, MenuSurface, Input })
createRoot(document.getElementById('root')).render(h('div', { className: 'fixture-dialog', role: 'dialog' },
  h('div', { className: 'fixture-head' }, 'Settings · isolated verification', h('button', { 'aria-label': 'Close' }, '×')),
  h('div', { className: 'fixture-body' }, h('aside', { className: 'fixture-side' }, h('div', {}, 'General'), h('div', {}, 'Models'), h('div', {}, 'Built-in plugins'), h('b', {}, 'MCP & Connections')), h('main', { className: 'fixture-main' }, h(Pane, { t: (key) => en[key] ?? key }))),
))
