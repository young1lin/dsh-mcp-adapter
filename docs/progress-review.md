# 统一插件实施进度复核

基线：主仓库 HEAD `64368a7`。本轮只审查、重建与测试，没有修复业务代码，没有重启现有 DSH，也没有迁移真实用户数据。

## 结论

大量模块已迁入，现有测试通过，但仍是整合中的原型，不能认定为“功能完整，只差重启/截图”。部分 TASK 勾选高于实际实现。本文件是审查证据，不是第二份实施 TODO；实施状态仍维护在 TASK.md。

## 1. 账面进度

按 P0.1 这类编号直接子任务统计，不包括父项、验收行与更深子项：

| 阶段 | 已勾选 / 编号任务 | 复核判断 |
| --- | --- | --- |
| P0 基线/契约 | 6 / 6 | 有文档，关键契约未被实际实现满足 |
| P1 打包/生命周期 | 7 / 7 | 引擎可独立测试，默认宿主启动链有缺陷 |
| P2 配置服务 | 7 / 7 | 有实现，来源写入与项目标识仍有问题 |
| P3 隔离/快照 | 7 / 10 | 核心阻断：同名实例覆盖，缺少真实运行代际 |
| P4 Tunnel | 9 / 9 | 迁入测试通过，真实 SSH/GUI 未验收 |
| P5 UI | 5 / 10 | 原生组件已出现，完整 CRUD 与高级功能未完成 |
| P6 迁移/安全 | 9 / 9 | 基础存在，默认 HTTP 管理面不符合设计 |
| P7 测试 | 7 / 10 | UI/性能/跨平台未验收，父项却勾选 |
| P8 部署验收 | 2 / 9 | 当前 URL 缺浏览器证据，宿主菜单补丁未部署 |
| 合计 | 59 / 77 | 仅为勾选数，不是真实完成率 |

TASK 顶部还称“仅设计未开始”；P7 父项完成但子项未完成；P8.1 README 已有更新却未勾选。需要整理状态，不能只依据最后几条 docs commit 宣称完成。

## 2. 本轮验证

执行顺序：`npm run typecheck` → `npm run build` → `npm test` → `npm run test:engine`，整体退出码 0。

- 类型检查、构建均通过。
- 宿主：77 passed，0 failed，0 skipped。
- 引擎：54 个测试文件通过；807 passed，2 skipped，总计 809。
- 大量 engine 测试验证的是旧网关行为，不能证明三级隔离和 DSH 集成正确。
- 本轮未重新执行 pack-check、Linux CI、真实 SSH、性能对比或当前 GUI 浏览器验收。

## 3. 优先修复的阻断

### R1 — 文档推荐配置不启动内置引擎

- `src/index.ts:136–163`：engine 启动位于 `gatewayConfig !== null` 的条件内部。
- README 推荐 `project: session, engine: true`。本轮用构建后的 validateConfig 检查，该配置的 engine 有值，gateway 为 null。因此干净安装按推荐配置不会进入 engine 启动分支。
- `src/index.ts:210–224,262–270` 还保留旧宿主级工具挂载与 workspace 安装链，需验证与新 agent-plane 的互斥。
- 修复方向：engine 成为独立主分支，旧路径仅兼容模式启用；测试真实宿主 apply 的最小推荐配置及不重复挂载。

### R2 — 不同项目同名服务替换同一运行实例

- `src/agent.ts:166–192` 注册、调用均以 entry.name 寻址，没有项目/会话/配置代际句柄。
- `src/engine/ipc-service.ts:488–524` 已有同名条目就执行 registry.updateDef；Registry 会停止旧实例并替换定义。
- 临时引擎实测：先 ensure audit_shared，description=workspace-A，再 ensure 同名 description=workspace-B，旧条目变为 B，没有两个隔离代际。自有测试引擎已停止，临时目录已清理。
- 影响：B 项目新会话可能改变 A 项目旧会话后续调用的连接目标，违背 P3.1/P3.3。
- 修复方向：逻辑名称与实例句柄分离，按 scope/config revision/凭据版本持有租约；补 A/B 同名不同目标的真实整合回归。

### R3 — 会话快照无法恢复旧连接定义

- `src/agent.ts:47–52,122–141,199–215` 快照仅记录 revision、时间和工具名；install 重新读取当前 preview 再写快照。
- 没有可恢复的服务定义代际、工具 schema，也未在安装时优先恢复旧快照。重启后不能保证仍用旧配置。
- `src/agent.ts:125–131` 把 cwd 当 workspaceId；GUI 使用宿主真实 workspace ID。native catalog 的身份映射可能不一致，需统一。
- 修复方向：规范化项目/会话身份；加密保存可恢复快照；旧代际不可恢复时明确不可用，不默默重算。

### R4 — 原独立 HTTP 管理面默认仍启动

- `src/engine/engine-main.ts` 总是 buildApp/listen，router 仍挂载旧 admin API 与 Dashboard。
- 临时引擎实测：未开启任何外部访问选项、无 bearer，GET `/` 和 `/api/mcps/audit_shared/details` 均返回 200。
- 这不是公网暴露结论，仍有 loopback 检查；但证明独立管理入口默认存在，绕过 DSH 管理服务，未满足显式开启外部端点的设计。
- 同一 registry 混入项目/会话服务，也不能直接作为外部发布列表。
- 修复方向：私有 IPC 管理与可选外部 MCP listener 分开；独立 Dashboard/admin API 不默认运行，外部服务显式 allowlist。

### R5 — 项目文件编辑不按实际来源写回

- `src/config/service.ts:220–230,279–287` 项目标准配置保存路径固定为根 `.mcp.json`。
- DTO 无来源层标识，定义若来自 `.agents/.mcp.json`，无法写回实际文件，可能冲突或生成无效低优先级副本。
- `src/client/pages/mcp.ts:24–32` 保存前刷新 revision，而非使用打开编辑时 revision，可能绕过编辑期间的冲突检测。
- 修复方向：后端提供受控 layerId，编辑器固定打开时 revision，冲突时保留草稿并显式处理。

## 4. UI 与部署仍有实际功能缺口

- `src/client/pages/mcp.ts` 创建是手写 JSON；详情只有 status/tools/resources/prompts/run，没有 Data 视图，也没有完整配置编辑向导。
- `src/client/pages/session.ts` 的当前状态使用最新 preview，不是持久化生效快照；获取全引擎状态不等于会话隔离视图。
- 独立 UI 审计确认：会话页仅 33 行只读展示；EntryEditor 没有 session 模式，client saveEntry 不传 sessionId。后端虽接受 ss 参数，网页无法创建/修改会话覆盖，也没有“以新配置创建后续会话”的入口。
- Data、调用日志、流量在 client/host bridge/IPC 三层缺少接入，不是已实现仅待实机验证。
- `src/client/pages/advanced.ts` 只提供默认 token 揭示，缺少命名 token 创建、轮换和吊销的 UI/桥/IPC。迁移 plan/apply 不是新插件状态的备份导出/恢复。原 lmg 源码保留但没有 bin 安装，也不算用户可用的等效恢复入口。
- 建议重新打开 P5.7（未部署）、P5.8（会话覆盖/日志缺代码）、P5.6（高级管理缺功能）、P8.2（矩阵标注失实）；P7 父项应恢复为未完成。不要把 feature matrix 的“◐ 已实现待实机”用于完全未实现的 Data 页面。
- `docs/workspace-menu-extension.md:20–33` 依赖宿主扩展部署，打开设置可能静默跳过；项目菜单不能按已上线入口计。
- DSH 源码与安装版版本不同，部署指令含占位路径，不是重启便必然生效。

## 5. 下一轮顺序

1. 先修 R1，确认推荐安装配置真正进入唯一 engine+agent 注册链。
2. 再修 R2/R3，落实实例隔离、运行代际、会话恢复和项目身份，加端到端测试。
3. 修 R4/R5，补默认 listener 策略、来源层事务写入及安全回归。
4. 对照功能矩阵补可操作 UI、迁移/备份恢复；旧 engine API 存在不算新 UI 已完成。
5. 最后部署可复现的宿主菜单补丁，在现有 3080 GUI 实测，再做性能与跨平台验收。

本轮没有批量改动 TASK.md 勾选，避免把一次抽查当成全仓验收。实施模型应依据上述证据重开对应任务，分开记录代码存在、测试通过、当前 GUI 已实测。
