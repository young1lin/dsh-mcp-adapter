# @young1lin/dsh-mcp-adapter（mcp-only 分支）

[English](README.md)

DeepSeek Harness（DSH）插件，只做一件事：把 MCP 服务器挂进每个会话自己的 agent 作用域，由插件自有的引擎子进程托管。这是 **mcp-only** 分支——SSH 隧道、数据库浏览器（mysql/redis/pg/mongo/rest 适配器）、流量环、备份/迁移、独立 `lmg` 网关形态已全部移除；完整功能在 `main` 分支。

## 你能得到什么

- **MCP 服务**：新建/编辑/删除/重命名/导入、分组、排序、启停、健康与进程管理——底层是标准 `.mcp.json` 文件（全局 `~/.agents/.mcp.json`、项目 `.mcp.json`）+ 插件私有的加密 native 目录（proc/http/echo 及第三方适配器）。
- **三层作用域**：global / project / session，墓碑式禁用、整条覆盖、同层冲突诊断、每会话快照。
- **会话工具**：由**宿主**直接注册进每个会话自己的 agent 作用域（等待 setup 屏障）——按工作区隔离工具集，不泄漏到全局，单服务器失败不影响其他。**无需任何 preset 改动；本插件不新增 preset，也绝不要求你写 preset。**
- **MCP 服务页**：保留配置、启停、工具/资源/提示词、工具调用与每 MCP 调用日志（区分 `panel` 与 `dsh-session` 来源），以及 stderr 捕获；不提供 Advanced 页、对外 HTTP MCP 端点、令牌管理或内存诊断。
- **安全**：宿主与引擎间是私有 stdio IPC；浏览器只能走同源 `/dsh-mcp-manager` 桥（回环 + 同源信任围栏）；列表 DTO 全部掩码密钥，落盘密封（DPAPI/绑机器）。

在 **添加 MCP → JSON** 中，可粘贴单个服务定义，或完整的 `{ "mcpServers": { "名称": { … } } }` 文档。编辑器默认取第一项并回填名称，其他项不会一并保存（要全部导入请用批量导入）。支持 HTTP 的 URL/headers 和 stdio 的 command/args/env；native/会话层会转换为完整 proc 命令行，并保留未知选项。可选字段收进 **高级设置**。

本分支**只支持引擎模式**：引擎默认开启；只有显式写 `engine: false` 才会拒绝启动。

## 安装

```bash
dsh plugin add @young1lin/dsh-mcp-adapter   # 或把 checkout 软链进 ~/.dsh/profiles/web
```

在 profile 的 `cordis.patch.yml` 里按**包名**挂载——完整条目就这两行：

```yaml
- id: mcp-json-adapter
  name: '@young1lin/dsh-mcp-adapter'
```

**不需要 `engine` 键**：插件自有的引擎子进程默认开启。仍可通过 `engine` 块设置 `storageDir` / `respawn` / `startupTimeoutMs` / `sessionTools`；旧配置中的 `httpPort` / `publicMcp` 为兼容起见仍可解析，但**不再生效**，旧 `listener.json` 也不会被读取；引擎始终不监听 HTTP，已有文件和密钥不会被删除。会话工具由宿主侧挂进每个会话自己的作用域——**不新增 preset、不改任何 preset**（`engine: false` 会被拒绝）。

然后打开 **设置 → MCP 与连接 → MCP 服务**（以及会话里的 **MCP** 标签页）；这里不再有 Advanced 标签。

### "引擎"是个什么东西？

插件自己拉起的一个私有子进程（`dist/engine/ipc-main.js`）：托管你配置的全部 MCP（proc 子进程、http 代理）、记调用日志，只通过一条 stdio 私有管道和 dsh 宿主进程说话。某个 MCP 崩了，死的是引擎、自动重生——dsh 本体永远不被拖下水。它在包里，不用单独装，也不会打开 HTTP 端口。

### 源码安装（mcp-only 分支）

```bash
git clone -b mcp-only https://github.com/young1lin/dsh-mcp-adapter.git
cd dsh-mcp-adapter && npm install && npm run build   # 必须构建；git 仓库里没有现成 dist
```

然后把 checkout 软链进 profile（`~/.dsh/profiles/web/node_modules/@young1lin/dsh-mcp-adapter` → 本仓库），patch 条目同上两行。拉了新提交后：`npm run build`，重启 dsh web。

## 配置自动发现与去重

默认同时读取以下标准文件（低优先级 → 高优先级）：

- 全局：`~/.claude/.mcp.json` → `~/.agents/.mcp.json`。
- 项目：`.claude/.mcp.json` → 根目录 `.mcp.json` → `.agents/.mcp.json`。
- 跨作用域：global → project → session。

按 MCP 名称合并去重；同名整条覆盖，不跨文件拼接字段，`disabled: true` 遮蔽低层配置。不同名称但定义相同的服务共用一个引擎实例，保留各自的工具命名空间。同层 standard/native 同名仍报告冲突。读取不迁移、不修改现有文件；面板编辑写回条目自己的来源文件并校验 revision。缺失文件正常跳过，坏 JSON/条目上报并隔离，不阻断健康服务。`.cluade` 拼写错误不作为配置目录。

显式设置非默认 `globalFile` 仍只读取指定的全局标准文件（替换默认两份），不额外读取用户主目录，避免意外引入工具。

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
