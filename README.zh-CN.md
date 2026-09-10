# @young1lin/dsh-mcp-adapter（mcp-only 分支）

[English](README.md)

DeepSeek Harness（DSH）插件，只做一件事：把 MCP 服务器挂进每个会话自己的 agent 作用域，由插件自有的引擎子进程托管。这是 **mcp-only** 分支——SSH 隧道、数据库浏览器（mysql/redis/pg/mongo/rest 适配器）、流量环、备份/迁移、独立 `lmg` 网关形态已全部移除；完整功能在 `main` 分支。

## 你能得到什么

- **MCP 服务**：新建/编辑/删除/重命名/导入、分组、排序、启停、健康与进程管理——底层是标准 `.mcp.json` 文件（全局 `~/.agents/.mcp.json`、项目 `.mcp.json`）+ 插件私有的加密 native 目录（proc/http/echo 及第三方适配器）。
- **三层作用域**：global / project / session，墓碑式禁用、整条覆盖、同层冲突诊断、每会话快照。
- **会话工具**：由**宿主**直接注册进每个会话自己的 agent 作用域（等待 setup 屏障）——按工作区隔离工具集，不泄漏到全局，单服务器失败不影响其他。**无需任何 preset 改动；本插件不新增 preset，也绝不要求你写 preset。**
- **MCP 端点**：可选对外发布一个 HTTP 端口，统一代理所有已配置的 MCP，支持命名 Bearer 令牌给外部客户端。
- **可观测**：每 MCP 调用日志（区分 `panel` 与 `dsh-session` 来源）、进程树内存、stderr 捕获。
- **安全**：宿主与引擎间是私有 stdio IPC；浏览器只能走同源 `/dsh-mcp-manager` 桥（回环 + 同源信任围栏）；列表 DTO 全部掩码密钥，落盘密封（DPAPI/绑机器）。

本分支**只支持引擎模式**：配置里没有 `engine: true` 时插件会报出明确的错误直接拒绝启动，而不是悄悄什么都不挂。

## 安装

```bash
dsh plugin add @young1lin/dsh-mcp-adapter   # 或把 checkout 软链进 ~/.dsh/profiles/web
```

在 profile 的 `cordis.patch.yml` 里按**包名**挂载——完整条目就这两行：

```yaml
- id: mcp-json-adapter
  name: '@young1lin/dsh-mcp-adapter'
```

**不需要 `engine` 键**：插件自有的引擎子进程默认开启（`engine` 块只用来调参数——`httpPort` / `publicMcp` / `storageDir` / `respawn` / `startupTimeoutMs` / `sessionTools`）。会话工具由宿主侧挂进每个会话自己的作用域——**不新增 preset、不改任何 preset，永远不需要**（`engine: false` 会被拒绝：本分支没有别的模式）。

然后打开 **设置 → MCP 与连接**（以及会话里的 **MCP** 标签页）。

### "引擎"是个什么东西？

插件自己拉起的一个私有子进程（`dist/engine/ipc-main.js`）：托管你配置的全部 MCP（proc 子进程、http 代理）、记调用日志，只通过一条 stdio 私有管道和 dsh 宿主进程说话。某个 MCP 崩了，死的是引擎、自动重生——dsh 本体永远不被拖下水。它在包里，不用单独装、不对外开端口（除非你主动发布端点）。

### 源码安装（mcp-only 分支）

```bash
git clone -b mcp-only https://github.com/young1lin/dsh-mcp-adapter.git
cd dsh-mcp-adapter && npm install && npm run build   # 必须构建；git 仓库里没有现成 dist
```

然后把 checkout 软链进 profile（`~/.dsh/profiles/web/node_modules/@young1lin/dsh-mcp-adapter` → 本仓库），patch 条目同上两行。拉了新提交后：`npm run build`，重启 dsh web。

## 作用域与生效时机

- 全局/项目层的保存对**下一个**会话生效；运行中的会话保持注册时的工具集（快照）。
- 会话层改动标记为 *待生效*，由之后创建的会话采纳。
- 标准文件始终是纯净的标准 JSON——面板和你的编辑器共享同一事实来源（revision 校验、原子写）。

## 卸载 / 回滚

禁用插件（或删掉条目）——引擎子进程优雅停机、进程台账清理；标准文件与 `~/.dsh/mcp-manager/` 下的密封私有存储原样保留。

## 开发

```bash
npm ci && npm run build          # tsc + esbuild 打 client bundle
npm test                         # 宿主侧测试（config/IPC/桥/agent/客户端）
npm run test:engine              # 引擎侧测试（vitest）
```

宿主契约见 `docs/dsh-integration-contract.md`。

## 许可

[MIT](LICENSE)
