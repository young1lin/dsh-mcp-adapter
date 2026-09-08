# dsh-mcp-adapter 重构与开源准备 — 设计文档

- 日期：2026-09-05
- 状态：设计已与用户逐节确认（方案 A + TypeScript 化）；应用户要求跳过书面规格审阅环节直接实施
- 目标仓库：`github.com/young1lin/dsh-mcp-adapter`（尚未创建，push 时建立）
- 许可：MIT，Copyright (c) 2026 young1lin

## 1. 背景与目标

现状：v0.3.0，9 个文件约 2500 行，纯 ESM JavaScript（JSDoc 标注），零 npm 依赖，
dsh 通过 `file:///` URL 直接加载 `src/index.js`。主要问题：

- `src/index.js` 约 1100 行混合六种职责（配置校验 / 文件规划 / 宿主模块加载 /
  session 桥接 / GUI 设置投影 / watch + 编排）
- `importMcpClient` / `importSchemastery` / `importMcpSdk` 三段宿主基址遍历加载
  逻辑重复约 80 行
- `SERVER_NAME_PATTERN` 在 index.js 与 gateway.js 两处定义
- 无自动化测试；README 为中文个人实操记录风格，含已脱敏的本机环境信息

本次目标（用户确认全选）：

1. 按职责拆分 index.js（方案 A）
2. 消除三类重复
3. 补自动化测试
4. 开源准备：TypeScript 化、LICENSE、英文主 README + 中文副、GitHub Actions CI

## 2. 非目标

- 不改任何运行行为：配置键、默认值、日志行格式、错误语义、挂载/重连策略原样
- 不改内部插件 id：Cordis name `mcp-json-adapter`、日志前缀、settings 命名空间
  `mcp-gateway`、client bundle id `dsh-mcp-json-adapter` 全部保留
- 不引入 bundler（tsup/esbuild 等），构建只用 `tsc`
- 不发布 npm 包（`file:///` 加载方式不变，发布留作后续独立决策）
- 不新增功能

## 3. 不变式（验收红线）

| 项 | 约束 |
| --- | --- |
| 入口 | `dist/index.js` 导出 `name='mcp-json-adapter'`、`inject=[]`、`apply(ctx, config)` |
| 兼容导出 | index 继续 re-export `projectGatewayEntry`、`gatewayConfigFrom` |
| 配置 | `CONFIG_KEYS` / `GATEWAY_KEYS` 集合与语义不变 |
| 日志 | `mcp-json-adapter: mounted N MCP server(s): ...` 等行格式逐字不变 |
| 密钥 | 密封存储格式（version 1 / entries / alg / iv / blob）与路径 `~/.dsh/mcp-json-adapter/sealed.json` 不变；token 解析顺序不变 |
| 浏览器侧 | client 侧行为与注册方式不变（仅语法 TS 化，保持 createElement 风格，不引入 JSX） |

## 4. 模块划分

依赖方向（无环）：

```
index  → config, plan, loader, session, settings, embed, gateway(间接)
config → shared, gateway
plan   → shared
session→ plan
settings→ gateway
loader → （无内部依赖）
gateway→ sealed
embed  → gateway
shared → （无内部依赖）
```

| 模块 | 内容（自现 index.js 迁出） | 预估行数 |
| --- | --- | --- |
| `shared.ts` | `SERVER_NAME_PATTERN`、`HTTP_TYPES`、`expandHome` | ~30 |
| `config.ts` | `CONFIG_KEYS`、`validateConfig` | ~140 |
| `plan.ts` | `readServerFile`、`expandEnvValue`、`toServerConfig`、`planServers` | ~250 |
| `loader.ts` | 统一 `importViaHost(ctx, specifiers)`（合并三段基址遍历）；`importMcpClient` / `importMcpSdk` / `importSchemastery` 薄封装；`unwrapModule` | ~120 |
| `session.ts` | `publicNameLite`、`extractTextLite`、`createOutputLite`、`createExecutorLite`、`configKey`、`clientByConfig`、`Holder`/`createHolder`、`withRetry`、`isConnectionError`、`clientFor`、`projectServersFor`、`installWorkspaceTools`、`scrubbedEnvLite` | ~380 |
| `settings.ts` | `SETTINGS_NAMESPACE`、`projectGatewayEntry`、`gatewayConfigFrom`、schemastery schema 构建 | ~140 |
| `index.ts` | `apply()`、`performSync`、reload 链、watch 块 | ~230 |
| `gateway.ts` / `embed.ts` / `sealed.ts` | 逻辑不变，补类型；`SERVER_NAME_PATTERN` 改从 shared 导入 | 不变 |
| `client.ts` | 语法 TS 化（React/dsh client API 用垫片类型） | 不变 |

被测纯函数从所在模块导出（`publicNameLite`、`extractTextLite`、`configKey`、
`validateConfig`、`resolveGatewayConfig`、`planServers`、`projectGatewayEntry`、
`gatewayConfigFrom`、`portOf` 等）；仅内部使用的函数保持不导出。

## 5. TypeScript 化

`tsconfig.json`：

- `target: ES2022`、`module: NodeNext`、`moduleResolution: NodeNext`
- `strict: true`（含 `noImplicitAny`；类型不全的宿主表面用受控 `any` 垫片，不降全局严格度）
- `declaration: true`、`sourceMap: true`、`outDir: dist`、`rootDir: src`、`include: ["src"]`
- `lib: ["ES2022", "DOM"]`（client.ts 需要 DOM 类型）
- NodeNext 下 ESM 相对导入必须带 `.js` 扩展名（指向编译产物路径）

devDependencies（仅开发期，运行时零依赖不变）：

- `typescript`、`@types/node`、`@types/react`
- `@deepseek-ai/dsh-mcp-client`（rc）、`@deepseek-ai/schemastery`、`@modelcontextprotocol/sdk`
- 类型垫片 `src/types/*.d.ts`：cordis `Context` 最小表面
  （`plugin`/`effect`/`on`/`inject`/`logger`/`get`/`baseUrl`/`root`/`tools`…）、
  dsh client（`window.__ModuleLoader__`、`slots`、`locale`、`settingsScope`）

`package.json` 变更：

- `name: "dsh-mcp-adapter"`
- `exports`：`.` → `./dist/index.js`、`./client` → `./dist/client.js`（附 `types`）
- `scripts`：`build = tsc`、`test = node --test test/`、`typecheck = tsc --noEmit`
- `files: ["dist"]`、`engines: { node: ">=20" }`
- `repository` / `bugs` / `homepage` → `github.com/young1lin/dsh-mcp-adapter`
- `dsh.client` 平台段保留原样

`seal-token.mjs`：import 改指 `./dist/sealed.js`（使用前需先 build）。

用户机器 rollout：`cordis.patch.yml` 的 file URL `src/index.js` → `dist/index.js`
（一次性切换；切换前重启 dsh 仍加载旧内存副本，不受文件替换影响）。

## 6. 测试计划

框架：`node:test` + `node:assert`，零新增运行时依赖。测试文件 `test/*.test.mjs`，
被测对象为构建产物 `dist/`（本地与 CI 同一流水：`npm ci → npm run build → npm test`）。

| 文件 | 覆盖 |
| --- | --- |
| `config.test.mjs` | `validateConfig` 默认值、逐键非法值、unknown key、`projectFiles`×`session` 互斥 |
| `plan.test.mjs` | tmp 目录写真 `.mcp.json`：三层合并覆盖、`disabled`、`disable` 列表、`${VAR}` 展开设/未设、stdio/http 字段映射、坏 JSON/坏条目错误信息、非法 server 名 |
| `gateway.test.mjs` | `resolveGatewayConfig` 全子键默认与校验；`discoverGateway` 替换 `globalThis.fetch` 打桩：不可达→null、`required`→throw、token 解析顺序 config > sealed(path) > env > api、include/exclude/groups 过滤 |
| `session.test.mjs` | `publicNameLite` 短名/规范化/哈希后缀、`extractTextLite` 各 content 类型、`configKey` 稳定性与字段敏感 |
| `settings.test.mjs` | `projectGatewayEntry` 空配置投影、`gatewayConfigFrom` 往返、embed 透传、patch-only 键保留 |
| `sealed.test.mjs` | seal→open roundtrip（tmp path）、坏 entry、store 版本检查、`putSecret`/`openSecret`（Windows 走真实 DPAPI） |

fetch 打桩方式：测试内替换 `globalThis.fetch`，不改生产函数签名。

## 7. 行为验证与 rollout

1. **基线**：切换前重启 dsh web，记录启动挂载日志行与一个项目会话的 session 挂载行
2. `npm run typecheck && npm run build && npm test` 全绿
3. `cordis.patch.yml` file URL 改指 `dist/index.js`，重启 dsh web
4. 对比：挂载日志行一致（数量/名字/语义）；项目会话 `mcp__<server>__<tool>` 工具存在；Requests 面板可开、可改、可存、保存后重载日志出现
5. `node seal-token.mjs --show` 确认密封存储路径与可读性
6. 转换期间不重启 dsh（运行中宿主持有旧副本，磁盘替换无影响）

## 8. 开源交付物

- `LICENSE`：MIT，`Copyright (c) 2026 young1lin`
- `README.md`（英文）：What/Why、Requirements、Install（clone + build + patch，含
  POSIX 变体）、Usage 配置表、Gateway 章节（embed/autostart/token 链）、
  Security（机器绑定密钥设计）、Reconnect 行为、Limitations
- `README.zh-CN.md`：现有中文内容整理保留，与英文版互链
- `.github/workflows/ci.yml`：push/PR 触发；矩阵 node[20,22] × os[windows-latest,
  ubuntu-latest]；步骤 `npm ci → typecheck → build → test`（双平台正好覆盖密封
  存储的 DPAPI 与 machine-id AES-GCM 两条路径）
- `package.json` 元数据补全（见 §5）

## 9. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| rc 版宿主包类型缺失/漂移 | 最小 `.d.ts` 垫片仅覆盖本插件用到的表面；垫片内受控 `any` |
| TS 转换引入行为漂移 | 函数体逐字迁移不改写；diff 审查；基线日志对比（§7） |
| 严格模式暴露存量隐式 any | 优先补真实类型；确无类型的宿主边界用显式 `any` + 注释 |
| NodeNext 扩展名要求 | 统一 `.js` 后缀导入；tsc 即时报错兜底 |
| 忘 build 导致 patch 指空 | README 安装步骤与 rollout 清单显式写 build；CI 保证可构建 |

## 10. 验收标准

1. `npm run typecheck && npm run build && npm test` 本地与 CI（双平台）全绿
2. `index.ts` ≤ 250 行；模块间无循环依赖
3. 三类重复消除：加载循环合一、`SERVER_NAME_PATTERN` 单点、校验风格统一
4. §7 行为验证清单逐项通过
5. LICENSE / 双 README / CI / package.json 元数据齐备；git 历史无个人环境信息
