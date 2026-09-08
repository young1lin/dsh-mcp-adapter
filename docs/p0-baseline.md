# P0 基线记录（2026-09-05 实测）

> 本文档是 TASK.md P0.1/P0.2/P0.6 的证据记录。全部数字来自本机实测，非推测。

## 1. 版本与提交（P0.1）

| 项 | 值 | 证据 |
| --- | --- | --- |
| 主仓 dsh-mcp-adapter | commit a972fb1（main），工作树干净（仅新增 TASK.md 未跟踪） | git status/log |
| 来源仓 local-mcp-gateway | commit 45884f1（main，与 origin/main 同步），工作树干净 | git status/log |
| Node / npm | v22.18.0 / 10.3.0 | node --version |
| 实际 DSH（GUI 服务进程） | @deepseek-ai/dsh@0.1.1-rc.2（全局 npm 安装），`dsh web` 监听 http://127.0.0.1:3080（HTTP 200 实测） | package.json + Get-CimInstance |
| 备用 DSH 源码 | <dsh-source>（非当前 GUI 来源，仅对照用） | — |
| local-mcp-gateway 全局安装 | npm link -> <gateway-repo>（0.1.0） | npm ls -g |

## 2. 插件加载与部署链路（P0.1，实测核实）

当前 GUI 加载本插件的真实链路：

1. `~/.dsh/profiles/web/package.json`：profile bundles 含 `dsh-mcp-json-adapter`，依赖为 `link:<repo>`（符号链接直连本仓库源码目录）。
2. `~/.dsh/cordis.patch.yml`：全局 patch 层 `insert` 条目 id=`mcp-json-adapter` name=`dsh-mcp-json-adapter`，携带 config（project: session; gateway.groups=[default], exclude=[echo], embed: true）。
3. 宿主半从 dist/index.js（经 profile 链接）加载；浏览器半经包内 dsh.client 配置（platform web, inject dsh-client-locale + dsh-client-ui-settings）由 client-module 扫描发现。已知限制（patch 文件内注释）：file:// 挂载发现不了浏览器半，必须包名挂载。
4. 当前嵌入式 gateway：`node --max-semi-space-size=2 --max-old-space-size=256 <gateway-repo>\dist\index.js`（由 embed 定位逻辑找到全局 npm link 的入口），监听 19999。本会话正在使用的 MCP 工具即由它承载 —— **运行期不得杀掉或重启该进程**。

## 3. 主仓基线构建与测试（P0.2）

命令序列（每条退出码 0）：

```
npm ci --no-audit --no-fund        # added 119 packages in 4s
npm run typecheck                  # tsc --noEmit 通过
npm run build                      # tsc 通过
npm test                           # 52/52 pass, 0 fail (node --test, 3.5s)
```

结论：基线绿。既有 52 项测试是"旧 adapter 行为"的回归网，整合过程中允许改写断言但不得无声删除。

## 4. 性能基线（P0.6，旧方案实测）

| 项 | RSS | 说明 |
| --- | --- | --- |
| 嵌入式 gateway 引擎进程（PID <pid>） | 59.3 MB | --max-semi-space-size=2 --max-old-space-size=256；当前无 proc 子进程（懒启动） |
| dsh web 宿主（PID <pid>） | 727 MB | 含全部会话/UI/工具 |
| 每个沙箱 pwsh 子进程 | ~103 MB | 参考值 |

启动时间：旧方案 gateway 冷启动待 P1 新引擎落地时同口径补测（同为 loopback /health 探活）。
本基线未连接任何生产 DB/SSH；用户已有的 MCP 配置仅被动观测。

## 5. 已识别的运行期风险

- 本会话工具依赖 PID <pid>：任何引擎替换/端口操作须先确认影响并留恢复通道。
- 来源仓有非本代理启动的 vitest 进程（用户其他窗口），不可干扰。
- `~/.dsh/cordis.patch.yml` 与 profile bundles 可能重复挂载同名插件（id 不同：mcp-json-adapter vs 包名）；P0.4 需核实 loader 去重规则，防止新插件双注册。
