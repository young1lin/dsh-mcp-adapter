# DSH 集成契约（实测版）

> 对象：本 GUI 实际使用的 DSH **0.1.5-alpha.2**（全局 npm 安装，`lib/bin.js web`，127.0.0.1:3080；实测 2026-09-10）。
> 源码仓 `C:\PythonProject\deepseek-harness` HEAD 与安装版**同版本**（0.1.5-alpha.2），本文所有源码引用直接给源码仓 `packages/**` 的 file:line，安装版为打包布局不含这些源文件。
> 上一版契约（0.1.1-rc.2）已过时：本版重测了它的全部结论，逐条标注存活/漂移/已解决。

## 1. 版本与布局

- 安装版：`%APPDATA%\npm\node_modules\@deepseek-ai\dsh`（lib/ + config/ + node_modules/@deepseek-ai/dsh-* 单文件 bundle）。
- 源码仓与安装版同版本，源码仓 API 可作为理解参考，但运行时事实仍以安装版行为为准。
- 引擎子进程由本插件 spawn(process.execPath)，无独立 node 版本要求；宿主 node 22.x。

## 2. 插件加载链路（实测存活，与 0.1.1-rc.2 相同；两处增量）

1. `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 数组 + profile node_modules 软链。
2. `~/.dsh/cordis.patch.yml` 全局用户 patch 层：`- insert: - {id, name, config}`（本插件 id=mcp-json-adapter，name='dsh-mcp-json-adapter'，config 含 project:session + engine:true）。insert 形状逐字节不变（vendor/include/src/index.ts:58-128、:145-156；条目按 id 去重，vendor/loader/src/config/tree.ts:69——双注册风险同旧）。
3. 宿主半从链接的 dist/index.js 加载；浏览器半由 client-module 扫描 package.json `dsh.client` 段发现。**增量①**：path-like/file:// 条目现在也能被浏览器半发现（locatePkgJson 经 internal.resolveSync + 最近 package 走查，packages/client/modules/src/index.ts:791-852）——旧"file:// 挂载发现不了浏览器半"的限制已消失；包名挂载仍是稳妥路径，本插件不变。
4. 双注册风险不变：只用一条注册路径（当前=全局 patch insert，bundles 列表不含本插件）。
5. 宿主半或 dist/client.js **代码**改动需重启 `dsh web` 生效。**增量②**：两个用户 patch 层（home 与 profile 的 cordis.patch.yml）在 web profile 上现在**热重载**（patchReload:'live'，packages/boot/app-boot/src/profile.ts:115-118；watchUserPatches，apps/cli/src/profile-boot.ts:372-381）——patch 里 **config 值的改动免重启即时生效**，代码改动仍需重启。
6. 发布侧备忘（docs/user/develop/basic/publish.md）：`dsh plugin add` 只把声明了 `dsh.bundle.patch` 的包并进 bundles；patch 替换整行 config（无深合并，改一行须重述全部键）；git 安装需自足的 prepare 构建脚本 + profile pnpm allowBuilds。本插件走 home patch insert，不受影响。

## 3. settings.section（存活）

- 客户端注册：`ctx.slots.inject('settings.section', () => ctx.slots.register({name:'settings.section', id, order, label, locale, inject}, Component))`（对照第一方用法：packages/client/ui-agent-preset/src/client/index.ts:196）。
- 宿主侧 `settings.installSection` 仍存在且被第一方使用（permission-presets、agent-default-model 等），hooks 增加可选 `validate`；另有新的 `settings.mutate(ns, pathOps, expectedRevision?)`——密钥掩码安全的写入路径（set/unset 算子、不复述未见字段，packages/settings/settings/src/index.ts:602-618），legacy 设置面将来可迁它。本插件 engine 模式不走这条路（apply 提前返回）。

## 4. conversation.view（**旧缺口已上游解决**）

- 槽位仍是 list + scope:'session'（packages/client/ui-conversation src/client/contract/slots.ts:156）。
- **框架标准 props 现在自带 `sessionId`、`useSession`、`useProjection`**（SessionStandardProps，packages/client/ui-session/src/client/index.ts:112-119）；注册行的 `inject` 回调也直接收 sessionId（第一方范例 ui-trajectory/src/client/index.ts:77-98）。旧契约"组件拿不到 sessionId"的 P5 缺口不复存在；本插件客户端已直接读 `props.sessionId`（src/client/index.ts:160）。
- owner 份额换成 `{viewRequest, openView, completeViewRequest}`（slots.ts:248-255）——旧 `{inspect, onInspectDone}` 在源码中已删除（仅残留在过期的 lib/ 产物里）。本插件未用过旧 owner 份额，无迁移。
- 标签环 order 语义不变（本插件 MCP=31）。

## 5. 会话创建、setup 屏障与两个 agent 事件（**0.1.5 关键变化区**）

### 5.1 setup 屏障（存活，且更强了）

- `CreateAgentOptions.setup` 仍被 **await 于 publish 之前**：setup 完成（含可选 commit）先于 `session/created`、`agent/created`、`agent/session-start` 和**首次 prompt assembly**；rejection 回滚整个创建（packages/core/agent/src/index.ts:102-118、:174-176；agent-loop 侧 setupAndPublish，packages/core/agent-loop/src/index.ts:824-835）。`AgentSetup` 增加了第二个 `agent` 参数（纯增量）。
- 旧符号 `resolveSessionPreset` 已删除；现行链路是 session-controller `composeAgent(presetId)` → `presets.resolve()` + setup 内 await `presets.mount(agentCtx, resolvedId)`（packages/api/session-controller/src/agent.ts:374-390）。会话的 preset 选择已持久化：创建头 `meta.agentPreset` + `agent-preset/selected` 事件 → `agentPreset` projection，**resume 断言 preset 未变**（agent.ts:459-466）；空白会话首回合后锁定切换。
- 只有 composition（preset 行 / composeAgent 的 setup）里的代码能享受这道屏障；宿主平插件天生在 composition 外，够不到。

### 5.2 agent/created（载荷字段全部存活）

- 载荷 `{ agent: Agent }`（runtime-types.ts:258）。`Agent.id: SessionId`（core/agent/src/types.ts:15）、`Agent.ctx: Context`（runtime-types.ts:174）、`Agent.session.header.cwd`（core/session/src/types.ts:104 `cwd?`）——本插件 agent.ts 读取的三个字段原样有效。
- 事件已改为 **scoped dispatch**（core/scope/src/scoped-events.generated.ts:12-18）：宿主层 `ctx.on('agent/created')` 依然收到（实测：新会话的 sealed 快照照常落盘）。
- 监听器 Promise 仍不被 await（fire-and-forget，同步异常与 rejection 按 listener 容错，core/agent/src/dispatch.ts:120-137）。

### 5.3 agent/pre-step（**载荷漂移 + 屏障顺序反转，本插件已按新事实重写**）

- 载荷：`{ agent, messages, turn, step, signal }`（runtime-types.ts:330）。**没有 `sessionId` 字段**；`agent` 由 fused dispatcher 在派发时注入（core/agent/src/dispatch.ts:113-118）——`agent.id` 即会话 id。本插件读取顺序已反转为 `agent.id` 优先（src/agent.ts）。
- **顺序反转**：新循环在 waterfall **之前**完成 `systemPrompt.assemble`（agent-loop/src/agent.ts:245 先于 :249），即该请求的工具目录（含 ptc 生成的 SDK 文本）在屏障派发前已冻结。屏障只延迟派发，不再能改变请求 #1 的工具目录。
- 每步 assemble 重新求值（core/system-prompt/src/index.ts:578、:599）——晚注册的工具出现在**下一步**；工具目录变化触发 `toolsChanged` → 强制开新请求序列（KV 前缀重置，agent-loop/src/agent.ts:261-266、:361-368）。
- 本插件的补偿：`agent/created` 即刻起注册（人类会话余量秒级）+ **prewarm 门闩**（src/agent.ts + src/runtime/session-runtime.ts）：宿主激活时把引擎已在托管的全局层 def 解析进安装缓存（def-hash 键，绑定 supervisor epoch），install() 对热 def 零 IPC 往返，机器驱动会话（子代理/fork 即刻首步）在工程上赢下 assemble 竞态。prewarm 探测 `start:false`、只认已 `started` 的孪生、自建行自清理，不改变引擎托管面。

### 5.4 工具如何到达模型（ptc presentation，新章节）

- 工具注册表在宿主平面，按 scope 层合并：会话自己的注册 → 链上祖先（preset standing 层）→ 全局层；restriction 只遮蔽继承面（core/tools/src/index.ts view() :1142-1183）。
- `agentCtx.tools.register(...)` 进会话自身层 → 每步 assemble 投影为模型可见 schema（README："registry feeds its schemas into the system-prompt assembly automatically"）。
- shipped preset 集合是 **cordis / minimal / ptc / standard 四个**（0.1.1-rc.2 至今不变；旧文档里的 'code' preset 不存在，README 那行是过期文案）。`ptc` = standard 全部行 + `dsh-agent-tool-presentation mode: ptc` 一行（presets/ptc/agent.cordis.yml:269-272）：模型只直调 `run_code`，其余工具进生成的 TypeScript SDK（`presentAs` 按 scope 生效，core/agent-tool-presentation/src/index.ts:59-72；SDK section 每步重渲，core/tools/src/index.ts:867-884）。**本插件注册的 mcp__ 工具实测出现在该 SDK 中**（0.1.5 会话 system message 里 12 处 mcp__ 声明）；ptc 是呈现模式而非另一套注册路径，`agent/created` + `tools.register` 与模式无关。
- 注意：`run_code` 是保留工具名（不可注册/遮蔽，core/tools/src/index.ts:1044-1045）；工具定义的 `output: {schema, render}` 契约仍是强制的（core/tools/src/index.ts:203-227）。
- `native` preset（standard/cordis）直发全部 schema；`both` 两者都发。

### 5.5 preset 体系的补充事实（源码核对 0.1.3-alpha.1→0.1.5-alpha.2 零 diff）

- 行的 `apply()` **每代每进程跑一次**（standing mount 单飞，src/index.ts:747-795），不是每会话；组合文件的 mtime+size 戳变化才开新代，运行中会话保持旧代。按会话记的状态必须以 agent 为键存在插件内部。
- 裸包名行从 **harness base**（roster 的 ctx.baseUrl，即安装的 harness/profile 内）经 `loader.internal.import` 解析（src/mount.ts:93-104）——profile node_modules 里的软链满足解析；`dsh-mcp-json-adapter/agent` 子路径导出行合法。
- **discovery 预解析每个非 disabled 行的包**（src/discovery.ts:116-127、:158-163）：包解析不了会把整个 preset 标为 BROKEN 并给出原因（列表可见、不挂载）——软链失效时用户 preset 会整体亮红，这是新的故障呈现面。
- mount 审计三拒不变：unscoped 目标、等不到服务的行、发布服务进 root realm 的行（须 group:true + isolate: 包裹；本插件 agent 行 inject:[] 不触发）。

## 6. 会话持久化 / fork / 恢复（格式升级，语义不变）

- 会话文件升为 `session.v3.jsonl.zstd`（header 含 `agentPreset`、`parentSession`、`isSeeded`、`delegationDepth`、`cwd`）。fork 的日志重放父会话旧 system message（无 mcp 工具是父代事实，不是故障）；fork 自己的新 system message 正常含工具。
- 无通用"插件每会话存储"API——本插件私有 sealed 快照方案不变（`~/.dsh/mcp-manager/sessions/`）。

## 7. Web 端 slot 盘点（0.1.5-alpha.2）

| slot | 处 | 形态 | 对本插件 |
| --- | --- | --- | --- |
| settings.section | ui-agent-preset/src/client/index.ts:196 | list | 「MCP 与连接」设置页 ✅ |
| conversation.view | ui-conversation contract/slots.d.ts:117 | list, scope=session | 会话 MCP 标签 ✅（sessionId 标准 props 直达） |
| conversation.session.header.utilities | slots.d.ts:105 | list | 备选入口 |
| workspace 项目菜单 | 仍无通用 slot | — | 缺口不变（Settings 内项目选择器过渡） |

## 8. 客户端 bundle 契约（存活）

- `window.__ModuleLoader__.load({id, factory(require)})`；factory 内 `require('react')` 可用；`module.exports={inject,apply}`；CSS `style[data-plugin-css]` 惯例不变。
- package.json `dsh.client {platform, inject}` 仍被 manifest 校验读取（packages/client/modules/src/client/manifest.ts:196-210）；新增宿主注入 `window.__DSH_BOOT__` 启动图（manifest.ts:80、:300），对本插件透明。
- apply(ctx) 依赖面 `['slots','locale','configForms']`（dsh 0.1.7 将 `settingsScope` 改名为 `configForms`，上游全部旧消费者同步替换；本插件未调用该服务，仅作激活顺序依赖）；`ctx.get('sessions')` 的 sessions 服务面（create/open/list.getSnapshot）仍按懒取防御。

## 9. dsh-mcp-client（已字段级核对：配置面不变）

- 源码位置：`packages/mcp/mcp-client`。插件 API 不变：Cordis 命名空间插件，`ctx.plugin(mcpClient, config)` 挂载，导出恰为 `{Config, apply, inject, name}`（lib/index.js:785；src/index.ts:29-146）。
- 配置字段零增删改：stdio `{transport, serverName, command, args=[], env={}, cwd='', toolCallTimeoutMs=60000, failOnStartupError=false, reconnect?}` / streamable-http `{transport, serverName, url, headers={}, …}`；`reconnect` 默认 `{enabled:true, initialDelayMs:500, maxDelayMs:30000, maxAttempts:10}`，退避耗尽会注销工具并停机（src/connection.ts:192-225）。工具命名 `mcp__<serverName>__<rawName>` 不变（src/tools.ts:112-118）。
- 相对 0.1.1-rc.2 的变化：serverName 唯一性从 per-app 收紧为 **per-registration-scope**（src/index.ts:154-168）；`./invariant` 子路径导出删除；0.1.3→0.1.5 仅新增 tools/list 重复游标拒绝（commit 594305ce19）。`@modelcontextprotocol/sdk` ^1.12 是它的直接依赖（随包传递可用）。
- 第一方消费仅两处：ACP 会话桥（packages/acp/acp/src/mcp.ts:26-74，agent 域挂载）与静态 cordis.yml 行（apps/cli/config/examples/mcp-memory/）。若经它挂载，其重连监管器会与插件引擎形成对同一子进程的**双重所有权**——engine 模式不走此路径，无冲突。
- **dsh 没有原生 .mcp.json 管理**（apps/、packages/、docs/ 零引用；Web 端无 MCP 设置面）。本插件的定位未被上游吞并。

## 10. 权限 / 授权

- dsh-authorization、dsh-user-approval、dsh-tool-ask-user 存在；插件工具的确认级别声明【仍未实测——P6】。

## 11. dsh home 路径

- `DSH_HOME` env → `~/.dsh`（本插件 sealed.ts / unified.ts 现行方案）；dsh-home-paths 包存在但未采用。

## 12. 风险与缺口汇总（0.1.5-alpha.2 版）

1. **assemble-先于-pre-step 的竞态**（§5.3）——已用 prewarm 门闩工程性覆盖；纯冷 def 的首个机器驱动会话仍可能首请求无工具（下一步补上，代价一次 KV 序列重置）。未在本机实证触发（9/8 以来无子代理会话样本）。
2. **conversation.view sessionId 缺口**——已上游解决（§4），客户端已用。
3. 项目菜单扩展位仍缺（§7）。
4. 双注册风险不变（§2.4）。
5. preset 行（`dsh-mcp-json-adapter/agent`）仍可用：preset 行=裸包名模块行的解析不变（从 harness base 走 profile 软链，§5.5）；**行内若提供服务必须置于 `isolate` realm**（本插件 agent 行 inject:[] 不提供服务，不触发）；subagent 天然加入父 composition（composeFrom），工具随父。注意新的故障呈现面：**discovery 预解析行内包**，软链失效会把整个用户 preset 标为 BROKEN（§5.5）。
6. preset standing mount 的行工具被该 preset 上所有会话从请求 #1 继承（§5.5）——但**本项目禁止任何 preset 新增**（用户明令，2026-09-10）：不得引导用户写 preset 行，也不得用 AgentPresets API 代写；"请求 #1 绝对保证"若要做，只能在宿主平面解决（prewarm 已是这条路的工程化形态）。
7. 升级 DSH 时按 §1 重测；本版契约引用源码仓 file:line（与安装版同版本）。0.1.1-rc.2→0.1.5-alpha.2 经 tag 级 diff 复核：loader/include/vendor 侧全部版本字段级变更（commit 6af96785b5），无未记录的破坏面。
