# DSH 集成契约（实测版）

> 对象：本 GUI 实际使用的 DSH 0.1.1-rc.2（全局 npm 安装，PID <pid>，lib/bin.js web，127.0.0.1:3080）。
> 全部结论来自安装版源码实测（文件+符号）；对照源码仓 <dsh-source> 为 0.1.3-alpha.1，仅作理解参考，契约一律以安装版为准。标注【未确认】的项需 P5 实测。

## 1. 版本与布局

- 安装版是打包布局：lib/（bin.js 入口）、config/（含 agent-presets/{standard,cordis,minimal,code}/）、node_modules/@deepseek-ai/dsh-*（全部子系统为已构建单文件 bundle）。
- 源码仓 0.1.3-alpha.1 与安装版存在差异；不得将源码仓 API 当作可用事实。

## 2. 插件加载链路（实测）

1. `~/.dsh/profiles/web/package.json`：profile 的 `dsh.profile.bundles` 数组列出插件包（本插件 `dsh-mcp-json-adapter` 以 `link:<repo>` 依赖进入 profile node_modules）。
2. `~/.dsh/cordis.patch.yml`（用户全局 patch 层）：可 `insert` 新 loader 条目并携带 config（本插件当前条目 id=mcp-json-adapter，config 含 project:session + gateway 块）；`~/.dsh/profiles/web/cordis.patch.yml` 是 profile 层 patch（bundles 之上）。
3. 宿主半经 loader 从 profile 链接的 dist/index.js 加载；浏览器半经包 package.json `dsh.client` 段（platform/inject）由 client-module 扫描发现——**file:// 挂载发现不了浏览器半，必须包名挂载**（patch 文件注释实测结论）。
4. 双注册风险：bundles 列表与全局 patch insert 同名不同 id 是否双挂载【未确认——loader 去重按 entry id，mcp-json-adapter(插入 id) 与包名派生 id 不同，理论上会两次 apply。P1 打包新插件时只用一条注册路径，规避该问题】。
5. 宿主半改动需重启 `dsh web`（用户授权）；客户端半改动经 client-module 重建后刷新生效。

## 3. settings.section（实测自现有插件运行）

- 客户端注册：`ctx.slots.inject('settings.section', () => ctx.slots.register({ name:'settings.section', id, order, label:()=>t, locale, inject:()=>({t,scope}) }, Component))`。
- 宿主侧：`settings.installSection(ctx, namespace, schema, entry, { setSource, onChange })`（schemastery 构建 schema；首次注册会触发一次 onChange，需吞掉）。scope 经 `ctx.settingsScope.bind({namespace})` 获得，有 subscribe/getSnapshot/set/unset；`snapshot.writable && mode==='host'` 才可写。
- 命名纠正：新插件设置页放 `settings.section` 下新 id（如 'mcp-connections'），不得占用 Requests 名（TASK 5.1）。

## 4. conversation.view（实测）

- 注册：`ctx.slots.register({ name:'conversation.view', id, order, label, locale }, Component)`；声明处 `dsh-client-ui-conversation/lib/client.js:10029`：kind=list、**scope:'session'**（conversation.session 子槽）。
- 组件仅收到 `{ inspect, onInspectDone }`（client.js:7419-7424），**不直接传 sessionId**。绑定真实会话需经 client 会话服务【P5 实测验证取法：ConversationSession 持有 sessionId；client 侧 sessions 服务（client.js:10023 sessions.open 同源）应可查询当前会话；否则经 settingsScope 之外的 client 连接 API】。
- 标签环顺序由 order 决定（现有 dsh-request-log Requests=30，本插件 MCP=31 紧随其后）。

## 5. 会话创建与 setup 等待屏障（关键）

- `agents.create(options)`（dsh-agent/lib/index.js:543）→ 工厂 `createAgent(ownerCtx, options)`（dsh-agent-loop/lib/index.js:1240）→ `setupAndPublish`（:1250-1263）：`await raceAbort(setup?.(prepared.agent.ctx), ...)` **先于 publish**。
- setup 回调来自 web 会话创建链：dsh-host-apiproxy `composeAgent(resolveSessionPreset(session))` → `composition.setup`（host-apiproxy/lib/index.js:1774、2117）。
- `agent/created` 事件（dsh-agent/lib/index.js:660-682）只发 `{agent}`，监听器 Promise 不被 await（仅记 warn）——**现有 adapter 的 void installWorkspaceTools 存在首轮请求竞态，TASK 风险表已列**。
- **正确挂载点：agent preset**（dsh-agent-presets）。preset 是目录（agent.cordis.yml + preset.yml），`ctx.agentPresets.mount(agentCtx, id)` 在 setup 内被 await（README "Where to call mount()"）：
  - 行 = 一个插件包名（从宿主 composition base 解析 bare specifier——profile 链接的本插件名可解析）、相对路径（preset 目录内）、绝对路径。
  - standing mount 一次/进程，会话按 scope 父链加入；工具注册进 preset 层（agent→preset→global 解析）。
  - 用户可创作根：`<dshHome>/.agent-presets`（trust=user）；authoring 仅 copy；composition 文件即编辑器。
  - 新会话快照语义天然成立：preset 代际按 composition 文件 stamp，运行中会话不换工具集。
- 迁移方案（P3 落地）：本包新增子入口 `dsh-mcp-json-adapter/agent`（agent-plane 插件：apply(ctx) 内完成合并配置解析→engine IPC tools/list→ctx.tools.register）；宿主插件提供"启用会话 MCP"引导：copy 当前默认 preset 到用户根并追加本行（或引导用户自建）；未启用用户保持旧行为。
- 子代理/fork：`composeFrom` 加入父 composition（同步 bind），子会话天然继承 preset 层工具；快照/覆盖按 TASK 3.x 由本插件私有存储处理。

## 6. 会话持久化 / fork / 恢复

- 持久化由 dsh-session-persistence-jsonl（profile patch 注释提到）承担：`resume(ownerCtx,{resumeSessionId,...})` 经 persistence.prepare 重放（agent-loop:1279-1308）。
- fork：host-apiproxy :2700-2710 `ctx.agents.create({... forkComposition.setup})`——fork 从存储的 session 构建 composition，**插件无关**；本插件按 sessionId 在私有目录持久化快照（P0.5 storage），恢复时校验 workspace 与 schemaVersion。
- 无通用"插件每会话存储"API【未确认存在与否——未发现；按私有目录方案走】。

## 7. Web 端 slot 盘点（安装版实测）

| slot | 处 | 形态 | 对本插件 |
| --- | --- | --- | --- |
| settings.section | 现插件在用 | list | 「MCP 与连接」设置页 ✅ |
| conversation.view | ui-conversation:10029 | list, scope=session | 会话 MCP 标签 ✅（sessionId 取法待实测） |
| conversation.hero.workspace | ui-workspace:2444 | — | 项目入口备选【未确认 props】 |
| sidebar.workspaces | ui-workspace:2434 | — | 侧栏工作区区【未确认 props】 |
| settings.general.item | ui-conversation:9910 | list | 不需要 |
| **workspace 项目菜单** | **无 slot** | — | **缺口**：ProjectRowItem 菜单写死 rename/delete（ui-workspace client.js:459-468）。需上游扩展（P5.7：给 dsh-client-ui-workspace 增通用 workspace.menu action 槽并重装；过渡方案=Settings 内项目选择器） |

## 8. 客户端 bundle 契约

- `window.__ModuleLoader__.load({ id, factory(require) })`：factory 体内 require('react') 可用；返回 module.exports={inject,apply}；CSS 用 style[data-plugin-css] 注入惯例（安装版包同款）。
- apply(ctx)：ctx.locale.register/bind、ctx.slots.inject/register、ctx.settingsScope.bind、ctx.effect。inject 声明 ['slots','locale','settingsScope']。
- 客户端插件包必须能被 client-module 扫描（包名挂载进 profile）。

## 9. dsh-mcp-client 契约（宿主侧挂载用）

- config: `{ serverName, transport:'stdio'|'streamable-http', command/args/env/cwd | url/headers, failOnStartupError?, toolCallTimeoutMs? }`（lib/index.js:39-47 实测）；工具名 `mcp__<serverName>__<rawName>`（规范化+哈希后缀规则同 session.ts 复刻）；env 有凭据形状清洗。
- SDK：宿主解析 @modelcontextprotocol/sdk v1（loader.internal.import，adapter loader.ts 机制不变）。

## 10. 权限 / 授权

- dsh-authorization、dsh-user-approval、dsh-tool-ask-user 存在；工具调用授权界面【未确认插件工具能否声明需确认级别——P6 安全阶段实测】。pwsh 沙箱等与插件无直接契约。

## 11. dsh home 路径

- dsh-home-paths 包存在【未确认其导出 API 形态——P1 使用时实测；保守做法：DSH_HOME env → ~/.dsh（现 sealed.ts 已用）】。

## 12. Node 与打包

- 安装版 package.json 无 engines；宿主进程即全局 node（本机 22.18.0）。
- 引擎子进程由本插件 spawn(process.execPath)，无独立 node 版本要求。

## 13. 风险与缺口汇总

1. **项目菜单无扩展位**（§7）——P5.7 上游扩展 or 过渡选择器；在宿主扩展部署前不得勾选"项目菜单入口完成"。
2. **conversation.view 无 sessionId 直传**（§4）——P5 实测 client sessions 服务取法。
3. **双注册风险**（§2.4）——新插件只走一条注册路径。
4. **preset 行是会话工具唯一可靠屏障**（§5）——P3 实现 agent 子入口 + 用户 preset 引导；不做 DOM 注入。
5. **插件每会话存储无宿主 API**（§6）——私有目录方案已冻结（P0.5）。
6. 安装版无 engines、对照源码版本漂移——所有契约引用安装版路径+行号，升级 DSH 时按 §1 重测。
