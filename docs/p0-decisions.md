# P0.5 冻结决策（2026-09-05）

> TASK.md P0.5 的结论记录。契约输入已由 docs/dsh-integration-contract.md（实测版）提供，本文件即为终稿。

## 1. Node 版本

- 引擎与插件统一声明 `engines.node: ">=22.19.0"`（与来源仓一致，取与 adapter>=20 的较高交集；DSH 安装包未声明 engines）。
- 本机 22.18.0 低于声明 0.0.1：engines 在 npm 默认不强制，实测来源引擎在 22.18.0 正常运行（本会话 19999 实例即证）。CI 矩阵固定测 22.19+ 与 24.x；不为本机降声明。

## 2. SDK 边界

- 宿主侧（dsh 工具注册）继续用宿主的 @deepseek-ai/dsh-mcp-client + 宿主解析的 MCP SDK v1（loader.ts 现机制不变）。
- 引擎侧迁入 @modelcontextprotocol/{client,server,node} v2（来自 gateway package.json，作为本包 dependencies）。
- 跨宿主↔引擎边界只传版本化 JSON DTO（shared/ 定义），绝不传 SDK 对象；两套 SDK 并存但各居其层。

## 3. 构建策略

- 仍零打包器：tsc 产 dist/。宿主入口 dist/index.js；引擎入口 dist/engine/main.js（独立子 tsconfig，含 engine 资产）；客户端 bundle 保持单文件工厂模式（require('react') 运行时解析），拆分为多页面源文件后由 tsc 产出、入口保持 client.ts 形态。
- package files：dist、.agents/skills（如保留）、README。admin 面板资产（index.html/js/css）不随默认发行——DSH 原生 UI 替代；引擎源码保留 admin 资产服务模块但发行 files 不含（P6 决定是否以可选兼容入口恢复）。
- 运行时不得依赖 devDependencies / npx 下载 / 相邻源码仓（来源仓默认只读）。第三方 npx/uvx MCP 命令是用户配置的 stdio 子进程，不受此限。

## 4. 目录布局（冻结为 TASK.md §2.1 版）

```
src/index.ts            # 宿主插件入口
src/host/               # DSH 集成、管理服务、权限、会话桥
src/config/             # 标准文件 + native catalog + 合并 + 迁移
src/runtime/            # 引擎进程管理、IPC 协议、租约/代际
src/engine/             # 迁入的 gateway 核心（adapters/tunnels/security/observability + engine-main）
src/client/             # DSH 原生 UI（pages/components/integration），client.ts 为组装入口
src/shared/             # 可序列化 DTO、schema、错误码
test/                   # node:test（宿主侧）+ 迁入的 vitest 套件逐步归一
```

## 5. Storage schema（终稿；home 解析按契约 §11 保守方案：DSH_HOME env → ~/.dsh，dsh-home-paths 服务实测可用后可切换，不改盘上布局）

- 根目录：`<DSH home>/mcp-manager/`（默认 ~/.dsh/mcp-manager/；经宿主 home 服务解析，不硬编码）。现有旧数据目录 ~/.dsh/mcp-json-adapter/sealed.json 由 P6 迁移。
- 每文件带 schemaVersion，首版 1：
  - catalog/global.json（native 全局服务定义，密封）
  - catalog/projects/<workspaceId>.json（native 项目定义；workspaceId=宿主 workspace ID，附规范化路径指纹供移动重联）
  - sessions/<sessionId>.json（会话覆盖+快照指针，密封）
  - runtime/engine.json（运行代际、租约、PID 账本——可重建，不密封）
  - tunnels.json / env.json / tokens（迁入 engine/security 同格式）
- 写入全部走 原子临时文件+rename；密文信封复用 engine/security（DPAPI/机器键）。
- 会话恢复规则：新会话工具注册经 agent preset 行（dsh-mcp-json-adapter/agent 子入口）在 setup 屏障内完成（契约 §5：setupAndPublish 先 await setup 再 publish；preset mount 是受支持挂载点）；fork 经 composeFrom 继承 preset 层，快照/覆盖由本插件按 sessionId 持久化；恢复遇 schemaVersion 不识别→该会话 MCP 标记不可用并明示，不静默换新。agent/created 事件路径仅作兼容过渡并逐步移除。

## 6. 兼容与迁移定位

- 旧 gateway 数据目录（%APPDATA%/local-mcp-gateway）只读预检→显式导入（P6），不自动收编。
- 现存 ~/.agents/.mcp.json 与项目 .mcp.json 保持标准明文格式，网页与文件同源（P2）。
