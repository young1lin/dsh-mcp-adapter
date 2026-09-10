# @young1lin/dsh-mcp-adapter

[English](README.md)

DeepSeek Harness（DSH）插件：按标准 **`.mcp.json`** 格式挂载 MCP 服务器——和 Claude Code、Cursor 等 MCP 客户端读的是同一个文件——项目（或整台机器）配置一次 MCP，任何 DSH 组合直接可用。

文件层之上还可以**自动发现** [local-mcp-gateway](https://github.com/young1lin/local-mcp-gateway) 托管的全部 MCP，并可选把网关进程**内嵌托管**：作为插件子进程拉起、日志接入宿主、崩溃按退避自动重启、随 DSH 优雅停机。网关相关的一切都可以在 DSH 设置对话框的 **Requests / 请求** 分区里运行时编辑。

## 工作原理

读取三层 `.mcp.json`，同名条目**后层覆盖前层**：

1. 全局层 `~/.agents/.mcp.json`
2. 项目根 `<项目>/.mcp.json`（Claude Code 同款位置，可直接共用文件）
3. 项目 `<项目>/.agents/.mcp.json`

每个条目成为一个 `@deepseek-ai/dsh-mcp-client` 实例，工具注册名为 `mcp__<serverName>__<tool>`。`"disabled": true` 的条目（或 `disable` 名单里的）跳过；文件里的未知键一律忽略，给其他客户端写的 `.mcp.json` 原样可用。

**工具只在加载时注册、运行中永不变化**：全局层随宿主激活定型一次，工作区层随会话创建定型一次——运行中变更工具集会打爆所有 prompt-cache 前缀、使会话历史与能力脱钩。改动在下一个加载周期生效（全局层重启宿主、工作区层新会话）。

`project: session`（推荐）下，每个会话读**自己工作区**的项目文件、把 server 挂进该会话自己的作用域——会话看到的就是"全局 + 本项目"。连接按项目目录共享。

第四层是可选的**发现层**（`gateway` 配置）：问网关的管理接口（仅回环）托管了哪些 MCP，全部挂载为 `http://127.0.0.1:19999/<name>`；显式 `.mcp.json` 条目仍按名优先。

## 环境要求

- Node.js >= 20
- dsh（`npx @deepseek-ai/dsh web`）
- 可选：[local-mcp-gateway](https://github.com/young1lin/local-mcp-gateway)（`npm i -g local-mcp-gateway`）

## 安装指南

适配器本体是 TypeScript 源码，安装 = clone + 构建 + 写两个配置 + 重启。以下按 Windows 记录（`npx` 安装的 dsh）；换机器只需替换路径。

### 第 0 步：构建

    git clone https://github.com/young1lin/dsh-mcp-adapter.git
    cd dsh-mcp-adapter
    npm install
    npm run build          # 产出 dist/（ESM + .d.ts）

目录放哪都行，后面用 `file:///` URL 引用 `dist/index.js`。不要挪进 dsh 安装目录（npx 缓存升级会被清掉）。

### 第 1 步：全局 MCP 配置 `~/.agents/.mcp.json`

所有会话共享的 server 写在这里（示例 = 一台 HTTP server）：

    %USERPROFILE%\.agents\.mcp.json

    {
      "mcpServers": {
        "web-search": {
          "type": "http",
          "url": "http://127.0.0.1:19999/web-search",
          "headers": { "Authorization": "Bearer <token>" }
        }
      }
    }

文件不存在就新建；不需要可以整个删掉（该层自动为空）。

### 第 2 步：把适配器挂进 dsh —— `~/.dsh/cordis.patch.yml`

在 patch 文件的 `- insert:` 列表里加一条：

    - insert:
        - id: mcp-json-adapter
          name: 'file:///C:/dev/dsh-mcp-adapter/dist/index.js'
          config:
            project: session      # 每个会话读自己工作区的 .mcp.json（关键）

注意 YAML 缩进：它必须与同一列表里的其他插件条目对齐。`project: session`
是按项目分发 MCP 的开关；不写则退化为"项目层跟 dsh 启动目录"的旧语义。

### 第 3 步：项目级 MCP —— 项目根放 `.mcp.json`

哪个项目要专属 server，就在哪个项目根放（Claude Code 同款位置，可直接共用）：

    D:\YourProject\your-service\.mcp.json

    {
      "mcpServers": {
        "mysql": { "type": "http", "url": "http://127.0.0.1:19999/mysql", "headers": { "Authorization": "Bearer <token>" } }
      }
    }

只在该项目工作区打开的会话可见；同名条目覆盖全局层。
也识别 `<项目>/.agents/.mcp.json`（两级都放时后者覆盖前者）。
server 名只允许 `[A-Za-z0-9_-]{1,32}`（它要拼进工具名）。

### 第 4 步：重启 dsh web

    npx @deepseek-ai/dsh web

patch/插件代码只在进程启动时加载——改完适配器代码、patch 条目或重新
build 后必须重启（改 `.mcp.json` 不用：全局层下次重启生效，项目层下个
新会话生效）。

### 验证

1. 启动日志有：`mcp-json-adapter: mounted N MCP server(s): ...`（全局层）
2. 在项目工作区开个新会话，问"你的 MCP 有哪些"；项目 server 的工具名形如
   `mcp__mysql__mysql_query`
3. host 日志每开一个会话多一行：
   `session workspace D:\YourProject\... mounted N tool(s) from M server(s)`

### 日常维护速查

| 想做什么 | 改哪里 | 何时生效 |
| --- | --- | --- |
| 加/删/改全局 server | `~/.agents/.mcp.json` | 重启 dsh web |
| 加/删/改某项目的 server | `<项目>/.mcp.json` | 该项目的下一个新会话 |
| 临时停用某个 server | 条目里加 `"disabled": true` | 同上（配置保留） |
| 运行中会话 | 什么都不会变（缓存安全，by design） | — |

### 卸载

删掉 `cordis.patch.yml` 里的 `mcp-json-adapter` 条目并重启即可，无其他残留；
`.mcp.json` 文件对 dsh 不再有读者（Claude Code 等仍可继续用）。

## 与 local-mcp-gateway 组合（v0.3：进程完全内置）

v0.3 起，**19999 那个网关进程本身就是这个 dsh 插件的子进程** —— 不需要谁先跑
`lmg start`：

- 插件激活时先探 `/health`：已有实例在跑（别的客户端启动的）就直接**附着**，绝不误杀；
- 没有实例就由插件 **spawn** `node --max-semi-space-size=2 --max-old-space-size=256
  <local-mcp-gateway>/dist/index.js`（与 `lmg start` 同配方，但不脱离进程组），
  `MCP_GATEWAY_PORT` 由配置的 URL 推出；
- 子进程 **stdout/stderr 全部接入宿主日志**（前缀 `gateway:`），意外退出按
  1s→15s 退避自动重启（上限 5 次，稳定 60s 后清零）；
- 插件卸载 / dsh 退出时先 `POST /api/shutdown` **优雅停机**（网关自己的 SIGTERM
  路径：关适配器、tree-kill proc 子进程、刷调用日志），5 秒没退才 `taskkill /T`；
  配置 `embed.leaveRunning: true` 可改为撒手模式（进程脱离 dsh 继续活，供其他客户端共享）。

进程之上是发现层：`GET /api/mcps`（仅回环）问网关托管了哪些 MCP，全部按
`http://127.0.0.1:19999/<name>` 挂载，网关面板仍是唯一事实来源。网关安装位置
自动探测（全局 npm 布局 / `npm root -g`），也可用 `gateway.embed.entry` 或环境变量
`DSH_MCP_GATEWAY_ENTRY` 指定。

### Requests 设置面板

插件自带浏览器半边（`src/client.ts`，声明在 package.json 的 `dsh.client` 里），
在 dsh 设置对话框里注册一个 **Requests / 请求** 分区，可编辑：

| 字段 | 含义 |
| --- | --- |
| 挂载网关 MCP 服务器 | 总开关（= `gateway` 层的 enabled） |
| 由 dsh 托管网关进程 | lifecycle 开关：开 = 插件 spawn/监护/收回网关子进程；关 = 使用外部已启动的网关 |
| 网关地址 | 留空用 `http://127.0.0.1:19999` |
| 分组 / 仅这些名称 / 排除名称 | 逗号分隔的过滤器（网关分组 / server 名单） |
| 令牌标签 | dsh 向网关认证用的 token 标签，默认 `dsh` |
| 网关不可达时启动失败 | required 开关 |

保存即写入 dsh 设置文档的 `mcp-gateway` 命名空间，宿主侧立刻重新挂载（与 watch
同款的整组换血，接受提示缓存前缀失效的代价）。patch 里的 `gateway:` 块是这层的
**基底**（base layer），GUI 改的是用户层；同名时显式文件条目仍优先于网关发现。

### 密钥只绑本机

面板里**没有 token 输入框**，这是刻意的。网关 bearer token 的解析在宿主侧按序进行：

1. patch 配置里的 `gateway.token`（不推荐，明文）
2. **机器密封存储** `~/.dsh/mcp-json-adapter/sealed.json`（Windows DPAPI
   CurrentUser + 应用熵；其他平台用机器序列号派生密钥的 AES-256-GCM）——
   手工放置：`node seal-token.mjs <token>`
3. 环境变量 `MCP_GATEWAY_TOKEN`（可用 `gateway.tokenEnv` 改名）
4. 网关自己：按标签找 token，没有就**自动签发**一个（默认标签 `dsh`，面板可单独吊销）

因此 dsh 落盘的任何文件（设置文档、密封存储）被复制到别的机器都只是密文；
网关自己的状态（`~/.mcp-gateway`，含 env.json、master.key）本来就是 DPAPI 密封的，
两台机器之间没有任何可搬运的明文密钥。自动签发的 token 不回写密封存储：网关侧
轮换后，下次宿主重启自然拿到新值，不会卡在旧密钥上。

### 启用

在 `cordis.patch.yml` 的适配器条目里加一行（或之后在 GUI 的 Requests 分区打开）：

    - id: mcp-json-adapter
      name: 'file:///C:/dev/dsh-mcp-adapter/dist/index.js'
      config:
        project: session
        gateway: true            # 全部分组；或 { groups: [default], exclude: [echo] }

可选子键（`url` / `groups` / `include` / `exclude` / `token` / `tokenEnv` /
`tokenLabel` / `createToken` / `autostart` / `required` / `fetchTimeoutMs`）见
[英文文档](README.md#usage) 的 Usage 表；`autostart` 在网关没起时会拉起
`npx -y local-mcp-gateway start`（或自定义 command/args）。

## 断线重连（HTTP 网关重启）

- 全局层走 mcp-client，其 supervisor 自动重连：500ms 起指数退避到 30s，每次断线
  最多 10 次（约 2.5 分钟预算）；连接稳定 30s 以上重置预算。
- 工作区层（session 模式）惰性自愈：注册的工具集不变，下一次工具调用（或下一个
  会话的工具列举）碰到关闭的连接就单飞重连一次并重试；重连失败表现为该次调用的
  错误，下一次调用再试。

## 开发

    npm install
    npm run typecheck     # tsc --noEmit，strict
    npm run build         # tsc -> dist/
    npm test              # node --test 测 dist/

`src/` 按职责拆成 11 个模块（编排 / 配置校验 / 文件规划 / 宿主加载 / 会话桥接 /
设置投影 / 网关发现 / 进程监护 / 密钥密封 / 浏览器面板 / 共享常量），模块地图见
[英文文档](README.md#development)。宿主包（`@deepseek-ai/dsh-mcp-client`、MCP SDK、
schemastery）经宿主内部 loader 按组合基址解析——和 dsh 用户预设同一机制——安装位置
旁边不需要 node_modules。

## 许可

[MIT](LICENSE)
