# AGENTS.md

本文件是本仓库给编码智能体（Claude Code、Codex 等）的唯一指导文件；根目录的 `CLAUDE.md` 是指向本文件的软链接，Claude Code 通过它读到同样的内容。不要在 `CLAUDE.md` 里另写内容。

## 项目是什么

本仓（GitHub 名 `dsh-mcp-adapter`）发布为 npm 包 **`@young1lin/dsh-mcp-adapter`**。这是 **mcp-only 分支**：一个 DSH（DeepSeek Harness）双面插件，把两件原本分开的东西合成了一个——

1. **MCP 配置与挂载** —— 读 `.mcp.json`（Claude Code 那套格式）与自有的原生条目，按 global / project / session 三层合并，把每个会话该有的工具注册进**那个会话自己的 scope**。
2. **MCP 运行时** —— 原 `local-mcp-gateway` 并入后的**引擎子进程**：托管 proc / http / echo 各类 MCP，带调用日志；旧 bearer 令牌存储仅为兼容保留，不通过浏览器提供管理入口。

`main` 分支还带着 SSH 隧道、数据库浏览器（mysql/redis/pg/mongo/rest 适配器）、流量环、备份/迁移与独立 `lmg` 网关形态；本分支把它们全部切除了，**只支持引擎模式**（默认开启，显式 `engine: false` 会报错）。设置页只保留 MCP 服务，不提供 Advanced。

GUI 里叫「MCP 与连接」，挂在 `settings.section` 槽。宿主契约见 `docs/dsh-integration-contract.md`。

## 常用命令

```sh
npm run typecheck      # tsc --noEmit，提交前必过
npm run build          # tsc + esbuild 打 client.js
npm run build:client   # 只重打浏览器半区

npm test               # node --test "test/*.test.mjs" —— 宿主/客户端/配置层，161 个
npm run test:engine    # vitest run --config vitest.engine.config.ts —— 引擎，279 个
```

两套测试框架**不是历史包袱，是边界**：`test/*.test.mjs` 用 node 内置 runner 跑宿主与浏览器半区（含一个手写的迷你 React），`test/engine/*.test.ts` 用 vitest 跑并入的引擎（沿用 gateway 原有的 supertest 用例）。新增测试放进对应那一侧，别混。

`npx tsc --noEmit` 只覆盖 `src`（tsconfig 的 `include` 就是 `src`）。改了 `test/**/*.ts` 想单独查类型，要显式点名并加 `--ignoreConfig`。

**构建前先清 `dist/`**：tsc 不删旧产物，删掉过的模块会以旧 `.js` 残留，动态 `import()` 在类型检查里也可能静默放过（`dist/session.js` 那次就是这样混过去的）。

## 架构

### 两个平面，一条私有管道

```
DSH 宿主进程 (dsh web, :3080)
│
├─ 宿主半区 src/host/ + src/runtime/ + src/config/
│   ├─ unified.ts      插件激活入口：解析配置 → 禁止外部 HTTP → spawn 引擎 → 挂 agent 平面
│   ├─ api.ts          /dsh-mcp-manager/* 浏览器 MCP 管理桥（loopback + 同源围栏）
│   └─ engine-supervisor.ts   引擎子进程的所有权、重生退避、孤儿回收
│
├─ 浏览器半区 src/client/  （esbuild 打成 dist/client.js，id 注入自 package.json）
│
└─ 引擎子进程  node dist/engine/ipc-main.js
    └─ src/engine/  registry / router / adapters(proc|http|echo) / calls / tokens
```

- 宿主与引擎之间是**行分隔 JSON over stdio 的私有管道**（协议在 `src/shared/ipc-protocol.ts`，方法表由 `engine/ipc-service.ts` 与 `engine/ipc-admin.ts` 合成，共 30 个：mcp 21 / tokens 5 / engine 4）。这条管道**永远不暴露给浏览器**，浏览器只能走 `/dsh-mcp-manager`；引擎也只认自己父进程的这对 fd。
- 插件启动引擎时强制 `httpPort: 0`、`publicMcp: false`，子进程再次强制禁用 HTTP。历史 `listener.json` 不再读取，旧 `engine.publicMcp` / `engine.httpPort` 虽可解析但无效。引擎内部仍保留旧 token/HTTP 代码与已有密钥数据，不能通过此插件的浏览器桥调用。

### 谁是大脑

**宿主是大脑，引擎是进程池。** 这是理解全局最关键的一条：

- 三层配置合并、workspace / session 语义、密钥掩码往返，全在宿主的 `src/config/`；
- 宿主把**算好的 resolved def** 通过 `mcp.ensure` 交给引擎，引擎按定义托管进程、路由调用、记日志；
- 所以引擎对 DSH 的 workspace / session 概念**一无所知**。

引擎自己那套 `gateway.config.json` + `managed.json` 是遗留账本（`managed.json` 仍承载开关/令牌状态），DSH 模式下不参与配置决策。

### 配置分层（`src/config/`）

| 文件 | 职责 |
| --- | --- |
| `standard-repo.ts` | `.mcp.json` 方言（command/args/env/url/headers/disabled，未知字段原样保留） |
| `native-catalog.ts` | 引擎方言 `ServerDef`（type: proc/http/echo/第三方 adapter），加密存储 |
| `session-store.ts` | 单会话覆盖 |
| `merge.ts` | **唯一**的合并算法：session > project > global |
| `service.ts` | 面向浏览器的唯一门面：按 scope id 取路径（浏览器永远不传路径）、拒绝符号链接逃逸、出站掩码、`expectedRevision` 乐观并发 |

标准路径优先级（高 → 低）：项目 `.agents/.mcp.json` > 根 `.mcp.json` > `.claude/.mcp.json`；全局 `~/.agents/.mcp.json` > `~/.claude/.mcp.json`。路径和 layerId 在 `standard-paths.ts` 统一定义，按逻辑名去重，编辑必须写回条目自己的层和 revision。非默认 `globalFile` 仍只读取指定文件。

合并规则要点：**整条替换，绝不跨源拼字段**；被标记 disabled 的提及是**墓碑**，会遮蔽所有更低层的同名条目；同一 scope 内 standard 与 native 同名是**冲突**，该名字直接排除并上报，不做静默选择。

注意：native 层的 proc 定义里 **`command` 是完整命令行**（standardToNative 会把 `.mcp.json` 的 command+args 拼进去，`tokenizeCommand` 再拆开）——给它传 `args` 字段会被静默忽略，表现为子进程起了却永远握手超时。

### 目录地图

| 目录 | 内容 |
| --- | --- |
| `src/host/` | 插件激活、MCP 管理桥 |
| `src/runtime/` | 引擎监管、会话运行时（逻辑名 ↔ 实例名、租约、预热缓存） |
| `src/config/` | 三层配置模型与门面 |
| `src/client/` | 设置页 MCP 服务及会话 MCP 标签页（`pages/` 下 mcp / session / entry-editor） |
| `src/engine/` | 并入的引擎核心（registry / router / adapters / calls / tokens） |
| `src/engine/adapters/` | proc / http / echo 适配器 + `proxy.ts`（远端代理层，工具/资源开关在这里生效） |
| `src/shared/` | 两侧共用：IPC 协议、实例命名、视图顺序 |
| `docs/` | 宿主契约；`TASK.md` 是分阶段实施计划 |

## 硬性约束

改动碰到下面任何一条，先读完再动手 —— 每一条都是踩过的坑：

1. **一个定义一个实例，不是一个名字一个实例。** `mcp.ensure` 按定义的稳定哈希（`stableDefinition`）匹配，命中就返回**已经托管它的那个实例**。调用方必须用**回包里的 `name`** 去寻址，不能用自己发出去的那个。这是"不同项目配了同一个 MCP，服务端只有一个实例"的实现方式。
2. **实例名 vs 逻辑名。** `instanceNameFor(workspaceId, logical, def)` 会把 workspace 和 def 都编进名字；而工具/资源开关这类**每条目设置**必须按 `logicalKeyOf(name)` 存，才能在改定义、换实例之后活下来。
3. **工具只在加载时注册，之后永不变。** 全局层在宿主激活时定一次，每会话层在会话创建时定一次。运行中改工具集会让 prompt cache 前缀全失效、并让会话历史与能力脱节。文件改动作用于**下一次**加载。
4. **外部端点永远关闭。** 不读取历史 `listener.json`，`publicMcp` / `httpPort` 均不能重新开启 HTTP；保留私有 IPC 管理桥、会话工具和 MCP 服务页面。不要清理用户存量密钥或配置文件。
5. **密钥掩码往返。** 面板拿到的是 `••••••••` 哨兵；保存时 `unmaskBody` 从存储里还原真值。改配置保存路径时，先确认这条链路没断，否则用户的密钥会被哨兵覆写。
6. **IPC 日志只记方法名、id 和错误码。** params / result 原样过管道，但绝不进日志行；域内脱敏归引擎的 mask 层管。
7. **代理层的工具屏蔽要两头都做。** 列表按页过滤（分页归远端所有，空页也要保留 `nextCursor`），并且被屏蔽的工具**必须不可调用**，用统一措辞 `unknown tool: <name>` 拒绝。
8. **严禁任何 preset 新增。**（用户明令，2026-09-10）插件不得要求、引导或代为创建/修改任何 `~/.dsh/.agent-presets` 下的 preset 行——会话工具一律由宿主侧挂载（`engine.sessionTools` 默认 true 的 unified 路径）。README/文档不得出现"给预设加行"类步骤；未来任何"请求 #1 绝对保证"类需求只能在宿主平面解决。

9. **取消必须在宿主本地收束。**（0.3.4 / dfd190d）`engine-supervisor.request` 的 abort 分支删除 pending、清 timer 时必须立即 `reject(E_CANCELLED)`，不能等待引擎回包；迟到回包已经找不到 pending，等待它会令 started 工具 body 永远悬挂，DSH 整步无法继续。预取消 signal 同样必须收束，cancel frame 只能 best-effort。回归测试须有独立 watchdog，并验证取消后同会话/共享实例其他会话仍可调用。
10. **pre-step 是 waterfall，不是通知。** 等 setup 屏障后必须 `return await next()`，未知会话、安装失败也照样继续；返回屏障 Promise/undefined 会破坏 `decision.kind`，让所有对话断掉。

## 活体验证

- 用户自己的 dsh 跑在 **3080**，管理桥在 `http://127.0.0.1:3080/dsh-mcp-manager/...`，可以直接 curl 验证真实状态（比读代码可靠）。
- 开发安装是软链：`~/.dsh/profiles/web/node_modules/@young1lin/dsh-mcp-adapter` → 本仓库。npm 正式包名是 **`@young1lin/dsh-mcp-adapter`**；无 scope 名 `dsh-mcp-adapter` 在 npm 上是别人的（2026-09-10 实测 403），曾短暂发布过的 `dsh-mcp-json-adapter` 已废弃指向正式名。
- **宿主半区或 `dist/client.js` 改了都要重启 dsh 才生效**（宿主缓存 client bundle）。重启是用户的动作，改完要明说。
- 量内存不要猜：`Get-CimInstance Win32_Process` 走真实进程树。引擎自身约 55–90 MB，大头一向是**被托管的 MCP 子进程**，那些是第三方 Node 程序，换什么语言监管它们都不会变小。

## 常见坑

- **Bash 工具会吃掉反斜杠**，即使在带引号的 heredoc 里。含 `\n`、`\/`、正则的补丁脚本要用 Write 工具落盘再执行，或者用 `chr(92)` 拼。
- **仓库行尾是混的。** `src/engine/**` 大多是 CRLF，其余多为 LF，且 `core.autocrlf=false`、没有 `.gitattributes`。用 Python 文本模式读写会把整个文件转成 LF，一个 30 行的改动会显示成 600 行。写回时保留原行尾（`newline=''` + 二进制敏感替换，或 Edit 工具）。
- **下拉框必须用真实 DOM 回归。** `autoFocus` 会在父弹层 ref 附加前触发 `focusin`，被 outside 判定误关；应在 effect 中等 ref 齐全后 `focus({ preventScroll: true })`。body portal 的 Tab/Shift+Tab 要先还焦 trigger 再走浏览器默认导航，避免宿主 modal trap 跳到首/末控件。保存位置选择必须整行是一个 button（含徽章和箭头），别只给标题绑事件。`test/client-dom.test.mjs` 覆盖这些真实 commit/ref/焦点与命中区边界；mini 不能代替它。
- **MCP JSON 编辑器兼容包装格式。** 粘贴 `mcpServers` 文档默认只取第一项并回填名称，批量导入保持原多条语义。HTTP 按 URL/headers 渲染；native/会话层的 stdio 要用 shared/command-line 把 command+args 转完整 proc 命令行，不能让 args 被静默忽略。标准层历史 type:proc 保留完整命令行 schema。真实 DOM 测试须覆盖掩码/未知字段保留、捕获 revision，以及显式 reload 后 useCallback 不再使用旧 revision。
- **表单宽度要测实际几何。** width:100% 还会叠加 content-box 的 padding/border；编辑器在自身 scope 内统一 border-box、min-width:0，并以 Chromium 在宽/窄容器中验证 scrollWidth 与控件 bounding rect，别只看 CSS 存在性。
- **迷你 React 测试夹具有限制**（`test/client-ui.test.mjs`）：`useEffect` 每个组件实例只跑一次且忽略依赖，`useCallback` 也忽略依赖。所以某个标签页要用的数据，必须搭 stub fetch 的返回一起给。
- **测试里不要自己算端口。** 用 `freePort()` 问操作系统。曾经用 `34000 + Date.now() % 1500` 算端口，模会重复，两个测试撞同一个端口后守护进程互相顶掉、活着的那个泄漏并占住端口，表现为"每次挂的用例都不一样、单跑全过"。
- **临时目录由 `test/engine/setup.ts` 统一沙箱化**：它建一个 per-file 沙箱并把 `TMPDIR/TMP/TEMP` 重定向进去，`afterAll` 加 `process.on("exit")` 双重清理。测试里照常 `mkdtempSync(join(tmpdir(), ...))` 即可，不要绕开它自己找系统临时目录 —— 绕开就会重现那次 5,703 个残留目录。
- **清理失败要出声。** 那 5,703 个目录之所以堆到没人发现，就是因为清理逻辑里有个静默的 `catch`。
