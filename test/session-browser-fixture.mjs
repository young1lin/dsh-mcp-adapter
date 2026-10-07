/** Isolated actual React session view. No live DSH, config, auth, or engine. */
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { kit, css } from '../src/client/ui.ts'
import { makeSessionTab } from '../src/client/pages/session.ts'
import { zh } from '../src/client/i18n.ts'
const h = React.createElement
const style = document.createElement('style')
style.textContent = css + `
:root{--dsw-alias-label-primary:#252527;--dsw-alias-label-secondary:#6b6b70;--dsw-alias-label-tertiary:#95959a;--dsw-alias-bg-base:#fff;--dsw-alias-bg-layer-1:#fff;--dsw-alias-interactive-bg-hover:#f5f5f6;--dsw-alias-border-l4:#d9d9dc;--dsw-menu-surface-fill:#fff;--dsw-radius-md:12px;--dsw-radius-sm:8px;--dsw-alias-brand-primary:#242426}
body{margin:0;background:#f4f4f5;font-family:system-ui,sans-serif;font-size:13px;color:#252527}.fixture-top{height:46px;border-bottom:1px solid #dedee2;display:flex;align-items:center;gap:20px;padding:0 20px;background:#fafafa}.fixture-top small{margin-left:auto;color:#8d8d93}.fixture-shell{display:flex;height:calc(100vh - 46px)}.fixture-sidebar{width:230px;flex:none;box-sizing:border-box;padding:24px 16px;border-right:1px solid #dedee2;line-height:36px;color:#78787e}.fixture-sidebar b{display:block;border-radius:8px;background:#e9e9ed;padding-left:12px;color:#3e3e43}.fixture-pane{width:1080px;max-width:calc(100vw - 230px);min-width:0;display:flex;flex-direction:column;background:white;position:relative}.fixture-tabs{height:48px;flex:none;display:flex;align-items:center;gap:24px;padding:0 24px;border-bottom:1px solid #eee;color:#8b8b92}.fixture-tabs b{color:#252527}.fixture-content{position:relative;flex:1;min-height:0}.fixture-scroll{height:100%;overflow:auto}.fixture-handle{position:absolute;top:0;bottom:0;width:40px;z-index:10;cursor:col-resize;background:#e3e3e322}.fixture-handle-left{left:calc(50% - 300px)}.fixture-handle-right{right:calc(50% - 300px)}.fixture-outer-splitter{position:absolute;top:0;right:0;bottom:0;width:5px;z-index:20;cursor:col-resize;background:#dedee277}.fixture-chat{margin:30px auto;width:min(600px,90%);color:#666}
`
// Exact latest host scrollport + sibling handle layout. Do not borrow its
// composer-overlay marker: that would also alter scroll/composer ownership.
document.head.appendChild(style)
const definitions = [
  ['microsoft-docs', 'http', ['microsoft_docs_search', 'microsoft_docs_fetch']],
  ['zhipu-search', 'http', ['web_search_prime']],
  ['zhipu-reader', 'http', ['webReader']],
  ['zhipu-vision', 'http', ['analyze_image', 'understand_technical_diagram']],
  ['zhipu-zread', 'stdio', ['get_repo_structure', 'read_file', 'search_doc']],
]
const servers = definitions.map(([name, transport, tools]) => ({ name, transport, tools: tools.map(tool => ({ name: tool, publicName: 'mcp__' + name + '__' + tool, description: ({ microsoft_docs_search: '搜索 Microsoft 官方文档，获取相关技术资料与链接。', microsoft_docs_fetch: '读取指定文档页面的完整内容。' })[tool] ?? '此工具的名称与描述来自本会话注册时的快照。' })) }))
const snapshot = { revision: 'frozen-v1', registeredAt: '2026-10-07T09:30:00.000Z', restorable: true, servers, tools: servers.flatMap(server => server.tools.map(tool => tool.publicName)) }
const latest = servers.map(server => ({ name: server.name, level: 'global', source: 'native', layerId: 'global:native', disabled: false, def: { type: server.transport === 'stdio' ? 'proc' : 'http', ...(server.transport === 'stdio' ? { command: 'node fixture-only.mjs' } : { url: 'https://fixture.invalid/mcp' }) } }))
latest.push({ name: 'new-mongo', level: 'global', source: 'native', layerId: 'global:native', disabled: false, def: { type: 'http', url: 'https://fixture.invalid/new' } })
window.fixtureRequests = []
window.fetch = async (url, init) => {
  const path = String(url)
  window.fixtureRequests.push({ url: path, method: init.method })
  if (init.method !== 'GET') throw new Error('Read-only fixture rejects all writes')
  const body = path.includes('/session?') ? { sessionId: 'fixture-existing', revision: 'session-v1', snapshot, capabilities: { nextSessionPreview: true }, configurationChanges: { added: latest.length - servers.length, removed: 0, changed: 0 } } : path.includes('/preview?') ? { forNextSession: true, layers: [], entries: latest, conflicts: [], problems: [] } : undefined
  if (body === undefined) throw new Error('Unexpected fixture API: ' + path)
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
}
const Tab = makeSessionTab(React, kit(React))
const host = document.getElementById('root')
createRoot(host).render(h(React.Fragment, {}, h('header', { className: 'fixture-top' }, h('b', {}, 'DSH'), h('span', {}, 'MCP 会话视图'), h('small', {}, '隔离浏览器夹具 · 非在线状态')),
  h('div', { className: 'fixture-shell' }, h('aside', { className: 'fixture-sidebar' }, h('div', {}, '对话'), h('div', {}, '配置变更回归'), h('b', {}, '本会话的 MCP'), h('div', {}, '新建对话')),
    h('main', { id: 'pane', className: 'fixture-pane' }, h('div', { className: 'fixture-tabs' }, '对话', '请求日志', h('b', {}, 'MCP')), h('div', { className: 'fixture-content', 'data-conversation-content': '' }, h('div', { className: 'fixture-scroll', 'data-conversation-scroll': '' }, h('div', { id: 'plugin-mount' })), h('div', { 'data-width-handle': 'left', className: 'fixture-handle fixture-handle-left' }), h('div', { 'data-width-handle': 'right', className: 'fixture-handle fixture-handle-right' })), h('div', { id: 'outer-splitter', className: 'fixture-outer-splitter', 'data-pane-resize': '' }))))
)
// React's host layout commits first; create the actual plugin child after it.
const mount = () => {
  const target = document.getElementById('plugin-mount')
  if (!target) { requestAnimationFrame(mount); return }
  const root = createRoot(target)
  window.fixtureShow = value => root.render(value === 'chat' ? h('div', { className: 'fixture-chat' }, 'Chat width handles return here.') : h(Tab, { t: key => zh[key] ?? key, sessionId: 'fixture-existing' }))
  window.fixtureAdd = name => latest.push({ name, level: 'global', layerId: 'global:native', def: { type: 'http', url: 'https://fixture.invalid/added' } })
  window.fixtureShow('mcp')
}
requestAnimationFrame(mount)
