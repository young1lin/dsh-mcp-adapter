# AGENTS.md

本文件是本仓库给编码智能体（Claude Code、Codex 等）的唯一指导文件；根目录的 `CLAUDE.md` 是指向本文件的软链接，Claude Code 通过它读到同样的内容。不要在 `CLAUDE.md` 里另写内容。

## 项目是什么

本仓（GitHub 名 `dsh-mcp-adapter`）发布为 npm 包 **`dsh-mcp-json-adapter`**——一个 DSH（DeepSeek Harness）双面插件，把两件原本分开的东西合成了一个：

1. **MCP 配置与挂载** —— 读 `.mcp.json`（Claude Code 那套格式）与自有的原生条目，按 global / project / session 三层合并，把每个会话该有的工具注册进**那个会话自己的 scope**。
2. **MCP 运行时** —— 原 `local-mcp-gateway` 整体并入，成为一个受管的**引擎子进程**：托管 proc / http / rest / mysql / redis / pg / mongo 各类 MCP，带调用日志、流量环、SSH 隧道、Web 管理面板。

GUI 里叫「MCP 与连接」，挂在 `settings.section` 槽。功能清单与 HTTP API 对照见 `docs/unified-feature-matrix.md`，宿主契约见 `docs/dsh-integration-contract.md`。

## 常用命令

```sh
npm run typecheck      # tsc --noEmit，提交前必过
npm run build          # tsc + 拷引擎静态资源 + esbuild 打 client.js
npm run build:client   # 只重打浏览器半区

npm test               # node --test "test/*.test.mjs" —— 宿主/客户端/配置层，159 个
npm run test:engine    # vitest run --config vitest.engine.config.ts —— 引擎，817 个
```

两套测试框架**不是历史包袱，是边界**：`test/*.test.mjs` 用 node 内置 runner 跑宿主与浏览器半区（含一个手写的迷你 React），`test/engine/*.test.ts` 用 vitest 跑并入的引擎（沿用 gateway 原有的 supertest 用例）。新增测试放进对应那一侧，别混。

`npx tsc --noEmit` 只覆盖 `src`（tsconfig 的 `include` 就是 `src`）。改了 `test/**/*.ts` 想单独查类型，要显式点名并加 `--ignoreConfig`。

## 架构

### 两个平面，一条私有管道

```
DSH 宿主进程 (dsh web, :3080)
│
├─ 宿主半区 src/host/ + src/runtime/ + src/config/
│   ├─ unified.ts      插件激活入口：解析配置 → 决定端点 → spawn 引擎 → 挂 agent 平面
│   ├─ api.ts          /dsh-mcp-manager/* 浏览器管理桥（loopback + 同源围栏）
│   ├─ listener.ts     对外 MCP 端点开关与端口
│   └─ engine-supervisor.ts   引擎子进程的所有权、重生退避、孤儿回收
│
├─ 浏览器半区 src/client/  （esbuild 打成 dist/client.js，由宿主 client-module 扫描）
│
└─ 引擎子进程  node dist/engine/ipc-main.js
    └─ src/engine/  registry / router / adapters / calls / traffic / tunnels / admin
```

- 宿主与引擎之间是**行分隔 JSON over stdio 的私有管道**（协议在 `src/shared/ipc-protocol.ts`，方法表由 `engine/ipc-service.ts` 与 `engine/ipc-admin.ts` 合成，共 51 个：mcp 21 / tunnels 14 / tokens 5 / engine 4 / traffic 3 / data 2 / env 2）。这条管道**永远不暴露给浏览器**，浏览器只能走 `/dsh-mcp-manager`；引擎也只认自己父进程的这对 fd。
- 引擎**已经是独立进程**了，不在 DSH 进程里。合并进来的独立守护模式代码（`src/engine/{bin,cli,daemon}.ts`，pid 文件 + loopback HTTP + start/stop/status）也还在，但 `package.json` **没有声明 `bin`**，所以当前没有以 `lmg` 之类的命令对外暴露。

### 谁是大脑

**宿主是大脑，引擎是进程池。** 这是理解全局最关键的一条：

- 三层配置合并、workspace / session 语义、密钥掩码往返，全在宿主的 `src/config/`；
- 宿主把**算好的 resolved def** 通过 `mcp.ensure` 交给引擎，引擎按定义托管进程、路由调用、记日志；
- 所以引擎对 DSH 的 workspace / session 概念**一无所知**，这正是它能同时以独立网关形态存在的原因。

引擎自己那套 `gateway.config.json` + `managed.json` 是独立模式用的另一套账本，DSH 模式下不参与配置决策。

### 配置分层（`src/config/`）

| 文件 | 职责 |
| --- | --- |
| `standard-repo.ts` | `.mcp.json` 方言（command/args/env/url/headers/disabled，未知字段原样保留） |
| `native-catalog.ts` | 引擎方言 `ServerDef`（type: mysql/redis/pg/mongo/proc/http/rest/echo），加密存储 |
| `session-store.ts` | 单会话覆盖 |
| `merge.ts` | **唯一**的合并算法：session > project > global |
| `service.ts` | 面向浏览器的唯一门面：按 scope id 取路径（浏览器永远不传路径）、拒绝符号链接逃逸、出站掩码、`expectedRevision` 乐观并发 |

合并规则要点：**整条替换，绝不跨源拼字段**；被标记 disabled 的提及是**墓碑**，会遮蔽所有更低层的同名条目；同一 scope 内 standard 与 native 同名是**冲突**，该名字直接排除并上报，不做静默选择。

### 目录地图

| 目录 | 内容 |
| --- | --- |
| `src/host/` | 插件激活、管理桥、端点决策、备份 |
| `src/runtime/` | 引擎监管、会话运行时（逻辑名 ↔ 实例名、租约） |
| `src/config/` | 三层配置模型与门面 |
| `src/client/` | 面板（`pages/` 下 mcp / tunnels / traffic / data / session / advanced / entry-editor） |
| `src/engine/` | 并入的网关本体（约 16.5k 行，其中 `admin/` 是它自带的原生 ES modules 面板） |
| `src/engine/adapters/` | 各类 MCP 适配器 + `proxy.ts`（远端代理层，工具/资源开关在这里生效） |
| `src/shared/` | 两侧共用：IPC 协议、实例命名、视图顺序 |
| `docs/` | 契约与迁移矩阵；`TASK.md` 是分阶段实施计划 |

## 硬性约束

改动碰到下面任何一条，先读完再动手 —— 每一条都是踩过的坑：

1. **一个定义一个实例，不是一个名字一个实例。** `mcp.ensure` 按定义的稳定哈希（`stableDefinition`）匹配，命中就返回**已经托管它的那个实例**。调用方必须用**回包里的 `name`** 去寻址，不能用自己发出去的那个。这是"不同项目配了同一个 MCP，服务端只有一个实例"的实现方式。
2. **实例名 vs 逻辑名。** `instanceNameFor(workspaceId, logical, def)` 会把 workspace 和 def 都编进名字；而工具/资源开关这类**每条目设置**必须按 `logicalKeyOf(name)` 存，才能在改定义、换实例之后活下来。
3. **工具只在加载时注册，之后永不变。** 全局层在宿主激活时定一次，每会话层在会话创建时定一次。运行中改工具集会让 prompt cache 前缀全失效、并让会话历史与能力脱节。文件改动作用于**下一次**加载。
4. **端点决策优先级：插件配置 > 面板存储 > 关闭。** 并且**端口被占用不能拖垮插件** —— 起不来就等于连能改端口的面板一起没了。`applyListener` 先真 bind 探测，占用就以"未发布 + 带原因"启动。探测必须用 bind，connect 探测分不清"没人监听"和"监听在别的网卡"。
5. **密钥掩码往返。** 面板拿到的是 `••••••••` 哨兵；保存时 `unmaskBody` 从存储里还原真值。改配置保存路径时，先确认这条链路没断，否则用户的密钥会被哨兵覆写。
6. **IPC 日志只记方法名、id 和错误码。** params / result 原样过管道，但绝不进日志行；域内脱敏归引擎的 mask 层管。
7. **代理层的工具屏蔽要两头都做。** 列表按页过滤（分页归远端所有，空页也要保留 `nextCursor`），并且被屏蔽的工具**必须不可调用**，用统一措辞 `unknown tool: <name>` 拒绝。

## 活体验证

- 用户自己的 dsh 跑在 **3080**，管理桥在 `http://127.0.0.1:3080/dsh-mcp-manager/...`，可以直接 curl 验证真实状态（比读代码可靠）。
- 开发安装是软链：`~/.dsh/profiles/web/node_modules/dsh-mcp-json-adapter` → 本仓库。npm 包名就是 `dsh-mcp-json-adapter`（`dsh-mcp-adapter` 这个无 scope 名在 npm 上是别人的，2026-09-10 实测 403；仓库名/目录名与包名不同无妨）。
- **宿主半区或 `dist/client.js` 改了都要重启 dsh 才生效**（宿主缓存 client bundle）。重启是用户的动作，改完要明说。
- 量内存不要猜：`Get-CimInstance Win32_Process` 走真实进程树。引擎自身约 55–90 MB，大头一向是**被托管的 MCP 子进程**，那些是第三方 Node 程序，换什么语言监管它们都不会变小。

## 常见坑

- **Bash 工具会吃掉反斜杠**，即使在带引号的 heredoc 里。含 `\n`、`\/`、正则的补丁脚本要用 Write 工具落盘再执行，或者用 `chr(92)` 拼。
- **仓库行尾是混的。** `src/engine/**` 大多是 CRLF，其余多为 LF，且 `core.autocrlf=false`、没有 `.gitattributes`。用 Python 文本模式读写会把整个文件转成 LF，一个 30 行的改动会显示成 600 行。写回时保留原行尾。
- **迷你 React 测试夹具有限制**（`test/client-ui.test.mjs`）：`useEffect` 每个组件实例只跑一次且忽略依赖，`useCallback` 也忽略依赖。所以某个标签页要用的数据，必须搭 `/status` 的返回一起给。
- **测试里不要自己算端口。** 用 `freePort()` 问操作系统（`daemon.test.ts` / `tunnel-api.test.ts` 都有现成写法）。曾经用 `34000 + Date.now() % 1500` 算端口，模会重复，两个测试撞同一个端口后守护进程互相顶掉、活着的那个泄漏并占住端口，表现为"每次挂的用例都不一样、单跑全过"。
- **临时目录由 `test/engine/setup.ts` 统一沙箱化**：它建一个 per-file 沙箱并把 `TMPDIR/TMP/TEMP` 重定向进去，`afterAll` 加 `process.on("exit")` 双重清理。测试里照常 `mkdtempSync(join(tmpdir(), ...))` 即可，不要绕开它自己找系统临时目录 —— 绕开就会重现那次 5,703 个残留目录。
- **清理失败要出声。** 那 5,703 个目录之所以堆到没人发现，就是因为清理逻辑里有个静默的 `catch`。
