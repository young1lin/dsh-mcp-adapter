# DSH 统一 MCP 与连接管理插件 — 设计与实施任务书

> 本文件交给后续实现模型执行。当前只完成方案设计，尚未开始功能整合。
> 目标不是“让 adapter 打开或配置外部 Gateway”，而是一个 DSH 插件完整提供两个项目的能力。
> 所有实现任务初始为未完成；必须根据真实代码、测试与界面验收逐项勾选，不能把计划当成完成结果。

## 0. 交接说明与执行纪律

### 0.1 项目位置

- 主工作区：`<repo>`。最终插件与本 TASK.md 在此维护。
- 能力迁移来源：`<gateway-repo>`。读取并迁移需要的源码、测试和许可；不把此绝对路径变成运行时依赖。
- 用户提供的另一份 DSH 源码位置：`<dsh-source>`。它不必然是当前 GUI 使用的构建来源。
- 本次环境指定的 DSH 实现位置：`<npm-global>\node_modules\@deepseek-ai\dsh`。本次检查到这里是安装包布局，包含 `node_modules/@deepseek-ai/dsh-*` 与 `lib`，不是完整 monorepo 布局。
- 当前 GUI：`http://127.0.0.1:3080`。不得启动另一个 Web 服务后宣称当前 GUI 已更新。
- 执行时先运行 `pwd`、检查 Git 状态，重新核实实际 DSH 版本、加载位置和部署方式；以上仅为设计时信息。

### 0.2 如何使用本清单

- 一次推进一个可验收的小阶段；先阅读当前文件与已有改动，不覆盖其他模型的未提交工作。
- 开始阶段时更新会话 TODO；每完成一个叶子任务，立即将对应 `- [ ]` 改为 `- [x]`，并在第 12 节追加证据。
- 父任务只有在所有子任务完成、该阶段验收通过后才能勾选。仅“代码写完但没验证”不能算完成。
- 有阻碍时保持未勾选，记录具体条件、已尝试动作及下一步；不得删掉未完成任务来制造完成状态。
- 每次交接必须更新第 11 节当前进度，包括下一项任务 ID、变更文件、测试结果、后台任务及是否需要重启。
- 本文件是实施状态的唯一主清单；若生成补充文档，必须从本文件链接过去，不能另建一份不同步的总 TODO。
- 允许按实测修订技术细节，但要在第 10 节说明原因。不能擅自退化为 iframe、外链网关页面或三套互不一致的配置。
- 不自动发布 npm、推送仓库、修改生产数据库、启用真实 SSH 隧道、抢占端口或重启用户正在使用的 DSH。涉及这些动作应先说明影响并获得授权。

### 0.3 本次调查边界

- 已阅读 adapter 的 `src/client.ts`、`src/settings.ts`、`src/plan.ts`、`src/session.ts`、`src/index.ts`、`src/embed.ts` 等核心路径。
- 已阅读 gateway 的 README、package.json、启动入口、加密状态文件模块、隧道类型，以及部分管理 API；尚未完成全仓 API/页面功能盘点。
- 已查看当前安装版 DSH 的 workspace UI：`ProjectRowItem` 的菜单项和分发逻辑写死为 rename/delete，不能假设已有项目菜单扩展槽。
- 上一轮 adapter 的 `npm run typecheck` 与 `npm test` 通过，报告 52 项测试；没有将其视为整合后的验收，也未在该轮重新 build。现有测试读取 dist，实施基线必须先构建再测试。
- 旧设计 `docs/superpowers/specs/2026-09-05-refactor-design.md` 仅约束上一次“不改行为的 TS 重构”。本次新增产品整合与行为变更以本文为准，不继续受其“零运行时依赖、只用 tsc、不新增功能”约束。

## 1. 产品目标与明确边界

### 1.1 必须交付

用户安装一个插件，在 DSH 内完成：

1. MCP 创建、编辑、删除、重命名、导入/导出、分组、排序、启停、健康与进程管理。
2. 全局、项目、会话三级配置，标准 `.mcp.json` 的读取和可视化编辑。
3. stdio/proc、远程 HTTP MCP、REST 工具、数据库直接适配与第三方适配器。
4. 工具、Resources、Prompts 浏览，工具开关、参数表单、手动调用和结果展示。
5. 现有数据浏览/编辑能力、调用日志、流量与子进程日志、内存及运行诊断。
6. SSH 连接、凭据、主机指纹、连接测试、Tunnel 生命周期、端口映射、重连和端口冲突诊断。
7. 环境变量、密钥、访问令牌、加密备份与恢复，以及已有外部客户端连接能力。
8. 随 DSH 启停，尽量复用可共享连接、延迟加载驱动、回收空闲进程。

最终无需单独全局安装或启动 local-mcp-gateway，无需打开 `19999` 的独立管理页面。

### 1.2 非目标与防止误解

- “一个插件”指一个安装入口、一个插件身份、一套完整界面与生命周期，不要求所有代码只有一个文件或一个 OS 进程。
- 不仅仅把原 Gateway 设置页改名；不能把独立网页嵌进 DSH 就认为整合完成。
- 不强制所有 MCP 都转成数据库直连适配器；保留任意第三方 stdio/HTTP MCP。
- 第一轮端口映射覆盖来源项目已有的 SSH 本地转发（`-L`）。不暗中承诺尚未确认存在的反向转发、SOCKS、UDP 或任意公网监听。
- 新增三级范围的是 MCP 配置与可用能力；SSH 连接与映射默认是宿主共享资源，项目/会话引用它们，不各自启动一套。
- 不做多人远程管理平台，不扩大来源项目的本机安全边界。
- 功能不能无声删除：若现有 CLI/页面能力需要改成新的入口，必须在功能对照表记录新入口与验收证据。

## 2. 总体架构决策

### 2.1 一个发行包，内部模块化

暂保留 npm 包名 `dsh-mcp-adapter`，UI 统一叫「MCP 与连接」；改名不是实现前置条件。保留旧入口的兼容迁移，不同时启用两套 MCP 工具注册器。

建议目录（目标布局，不是已存在文件）：

```text
src/
  index.ts                     # 唯一宿主插件入口、资源销毁
  host/                        # DSH 集成、管理服务、权限、会话桥接
  config/                      # 标准文件、native 定义、合并、版本、迁移
  runtime/                     # 内部引擎启动、协议、租约、实例代际
  engine/                      # 从 gateway 迁入的运行核心
    adapters/                  # 数据库/proc/http/rest/第三方
    tunnels/                   # SSH、转发、连接池、诊断
    security/                  # 密钥、加密状态、脱敏
    observability/             # 调用/流量/进程日志与指标
  client/                      # DSH 原生 UI，不包含独立后台站点
    pages/                     # MCP、服务详情、SSH、映射、日志、高级
    components/                # 共享表单、来源标签、状态、确认对话框
    integration/               # settings、project、conversation 入口
  shared/                      # 可序列化 DTO、schema、错误码
test/                          # 单元与集成测试，允许按领域拆分
docs/                          # 功能对照、迁移、安全、验证记录
```

- 引擎代码迁入主仓库，记录来源提交与 MIT 许可；不得依赖旁边 gateway 仓库才能运行。
- 本次执行以主仓库为唯一实现地点，来源仓库默认只读，避免形成两个长期分叉的实现源。
- 构建输出必须包含宿主入口、client bundle、内部引擎入口及运行资产；插件基础启动不能依赖 devDependencies 或临时下载 npx 包。用户明确配置并授权的第三方 npx/uvx MCP 命令仍可执行，不与此限制混淆。
- 保留扩展适配器加载能力，但只对用户明确授权的模块加载，不自动执行陌生项目文件。

### 2.2 内部引擎作为受控子进程

首版采用一个随插件安装的引擎子进程，宿主经版本化私有协议调用它。用户不感知另一个产品。原因：来源代码含全局信号、环境、进程清理逻辑，不宜直接 import 到 DSH 主进程。

```text
DSH Browser
  → DSH 已有身份/权限下的插件管理服务
    → 配置服务 + 会话快照服务
      → 插件私有 IPC
        → 一个受控 Engine
          → 数据库驱动 / SSH 连接 / proc MCP 子进程
```

- 控制通道优先使用父子进程 IPC，禁止把无鉴权的原管理 HTTP API 直接代理给浏览器。
- 引擎核心抽出显式 start/dispose；CLI 信号处理、全局 PATH 修改、遗留进程扫描留在兼容入口，不在模块导入时执行。
- MCP 对外 HTTP 端口仅在开启「供其他客户端使用」时监听 loopback，保留令牌与 Host/Origin/peer 校验。内部管理不依赖固定 19999 端口。
- 插件停用/DSH 正常退出时释放自己拥有的引擎和子进程；异常退出通过父进程通道断开、拥有者标识和精确进程账本清理。
- 多 DSH 宿主、已有外部网关、端口占用必须识别。首版不跨宿主自动合并运行实例，也不误杀既有进程。外部网关兼容连接是可选迁移模式，不是默认安装要求。
- 按相同配置与安全边界共享实例；引用计数、空闲回收、日志保留上限必须明确。不能只按 server 名称复用。
- 内存目标靠消除重复实例与懒加载；不承诺未经实测的 MB 数字，也不能把 V8 heap 限额当成总 RSS 限额。

### 2.3 宿主与引擎的职责边界

- 宿主拥有：全局/项目/会话身份、配置读写、覆盖规则、工具授权、运行代际选择、UI 服务。
- 引擎拥有：连接与进程、协议适配、Tunnel、实际调用、受限观测数据。
- 引擎不能把“注册过的全部 MCP”自动暴露给每个 DSH 会话。
- DSH 模型工具调用继续通过宿主 tools/权限/取消机制；UI 手动调用作为独立管理动作鉴权和审计，不伪造为模型调用。
- DSH 与 gateway 当前 MCP SDK 主版本不同，跨边界只传版本化 JSON/二进制封装，不传 SDK Client/Server/Transport 对象。

## 3. 配置模型：一处定义，按范围覆盖

### 3.1 三类数据必须分开

| 类型 | 保存位置/归属 | 规则 |
| --- | --- | --- |
| 标准 MCP 全局定义 | 默认 `~/.agents/.mcp.json`，兼容 globalFile | 网页直接读写同一文件 |
| 标准 MCP 项目定义 | `<project>/.mcp.json`；兼容 `<project>/.agents/.mcp.json` | 明示实际源文件，后者优先 |
| 插件 native 定义 | 插件私有加密目录中的全局/项目 catalog | mysql/rest 等非标准定义，不伪装成标准 MCP 文件 |
| 会话级覆盖 | 插件私有加密 sessions 存储，绑定真实 DSH session ID | 不写回全局或项目；支持重启/恢复 |
| SSH/映射/密钥/高级选项 | 插件私有加密状态目录 | 宿主管理，项目和会话按 ID 引用 |
| 运行状态与快照 | 有版本的运行记录、会话快照及日志 | 不将“已保存”冒充“已加载” |

建议私有目录为 DSH home 下 `mcp-manager/`，由 DSH home 服务解析，不硬编码用户目录。新目录格式含 schemaVersion，项目使用宿主 workspace ID 与规范化路径映射，迁移或移动时显式重新关联。最终路径与服务接口在 P0 验证后冻结。

### 3.2 唯一来源与标准兼容

- 标准 `.mcp.json` 保持合法明文 JSON 与通用 `mcpServers` 格式，不能套 gateway 的加密 envelope。鼓励 `${ENV_VAR}` 引用，不默认写入新明文秘密。
- 网页编辑标准服务时，读取完整原始文档并保留未知字段和未编辑条目，不从已展开/已规范化的运行配置反向生成文件。
- 一项服务的持久化来源只有一个：标准文件或 native catalog。运行时注册不是第二份用户可编辑副本。
- 同一级的标准/native 同名定义视为冲突，明确诊断并要求改名/迁移，不静默选择其中一方。项目两个标准文件按历史顺序覆盖，不视为该冲突。
- native 服务需要给其他客户端使用时，可显式导出指向插件 HTTP 端点的标准连接配置；该导出不是 native 定义的第二个编辑源。
- 遗留 gateway.config/managed override 先按旧规则合成最终结果，再导入唯一来源，避免继续维护双写覆盖链。
- 导入是一次性复制并预览冲突；“链接已有文件”是持续以该文件为源，两者必须分开命名。

### 3.3 合并、禁用与隔离

- 优先级：会话 > 项目 > 全局；同名服务整条定义替换，不拼接不同来源的 command/env/headers。
- 项目层内部顺序：根 `.mcp.json` → `.agents/.mcp.json`；UI 默认新建写根文件，编辑已有项写它实际来源，不能静默创建更高优先级副本。
- 禁用用显式 tombstone/disabled 语义保留到合并结束；能够屏蔽所有较低层来源，包括兼容网关发现来源。
- 删除本级覆盖 = 恢复继承；在本级禁用 = 屏蔽继承。UI 提供不同操作与确认文案。
- 会话面板默认列出全局+项目+会话合成后的全部可用服务，而不是仅显示会话本级条目。
- 每项返回来源路径/范围、是否继承、被覆盖来源、配置 revision、加载 revision、pending 状态。秘密不进入普通列表 DTO。
- 外部客户端默认仅能发现显式发布的全局服务；项目/会话私有实例不因复用引擎而出现在公共列表。
- 共享键包含传输类型、完整有效配置标识、cwd、凭据版本、隔离策略；有状态或未知可共享性的第三方服务默认隔离，允许用户明确选择共享。

### 3.4 文件事务与凭据编辑

- 读取返回 revision/hash，保存携带 expectedRevision；外部编辑导致冲突时拒绝覆盖，并提供重新读取/差异预览。
- 所有插件写入经过每目标串行队列、写前校验、临时文件+原子替换；实现要写明无法让不配合的外部编辑器参与完整事务的边界。
- 存在任意非法 JSON/校验错误时不覆盖原文件，不销毁当前有效运行代际。
- 浏览器传 workspaceId/sessionId 与配置层选择，不传任意宿主文件路径；后端解析并检查路径、符号链接/越界、访问权限。
- 处理 Windows Unicode 路径、大小写/路径规范化、文件不存在、只读文件、失去工作目录等情况。
- 密码框提供 keep/set/clear 三态。脱敏占位符绝不能写回成为真正密码；clear 必须是显式动作。
- 加密状态、备份和日志都不能回退为静默明文；密钥不可用时给出明确只读/恢复流程。不能更改或加密用户的标准 `.mcp.json` 来解决此问题。

## 4. 会话快照与生效时机

### 4.1 默认策略（本次有意改善旧行为）

- 保存全局/项目配置：对下一次新建会话生效，不要求每次改全局服务都重启 DSH。
- 新会话：在第一次模型请求前，解析配置、完成所需 tools/list、持久化快照并注册工具。必须有可靠等待屏障，不能继续使用 fire-and-forget 的 agent/created 加载。
- 已存在会话：固定服务配置代际和工具 schema；普通保存不自动改变其工具集。
- 已有会话修改会话覆盖：保存为待生效配置，提供「以新配置创建后续会话」；会话内无损热切换不是首版前提，不假装已即时生效。
- 如果 DSH 具有可验证的安全工具集切换机制，可作为后续显式功能；不得在模型运行中替换。
- 会话恢复/宿主重启：从持久化快照恢复；无法恢复某个旧版本时显示不可用，不静默换成新连接或扩权。Fork 默认复制快照与会话覆盖，再按新工作区校验；子代理遵守父级授权边界。

### 4.2 运行代际与安全停止

- 老会话保留旧定义租约，新会话取得新 revision；不能只在 UI 显示旧版本，底层却已把共享实例更新成新数据库。
- 一次保存整体校验/提交一次，避免逐字段保存触发多次全量重挂载。
- tools/schema 快照固定不代表实际数据库数据、资源列表等业务内容固定，UI 应明确区分。
- 用户显式 Stop/撤销授权属于运行控制，可立即阻止后续调用；列出受影响会话与外部客户端。不能以保护快照为由继续允许已撤销能力。
- 正在执行的调用支持取消/超时，强制终止前说明副作用不保证回滚。写操作在连接中断后不能默认自动重试，以免重复执行。
- Tunnel 的配置与连接不是会话快照。停止/改端口可能影响多个使用者，必须有影响预览；重连通知关联适配器连接池失效，不能悄悄改变目标地址。

## 5. UI 信息架构

### 5.1 三个入口，同一组组件

```text
Settings → MCP 与连接
  MCP 服务                 # 全局服务；可选择项目进入项目管理
  SSH / Tunnel
    SSH 连接
    端口映射
  日志与诊断
  高级设置                 # 密钥、环境、令牌、外部访问、备份恢复

左侧项目名称 ⋯ → MCP 配置
  项目定义 / 继承结果 / 关联连接

会话顶部 Chat | Trajectory | Requests | MCP
  当前生效 / 会话覆盖 / 待生效变更 / 本会话调用
```

- 不再把 MCP 设置放在名为 Requests 的 settings.section 中；保留别的插件的 Requests 标签不动。
- 顶部 MCP 的管理操作必须绑定该会话 ID；全局管理链接明确标注会影响所有相关会话。
- 项目配置不要求先创建会话；项目入口打开插件管理工作台/面板，显示明确的项目标题和返回位置。
- MCP 详情复用：概览、配置、Tools、Resources、Prompts、运行、数据浏览（适用类型）、日志。
- 创建向导先选范围，再选标准/数据库/REST/第三方类型；显示实际写入位置、秘密保存方式、是否通过已有 Tunnel。
- SSH 与端口映射是同一隧道领域的两个视图，不维护两套重复的映射模型。
- 密钥管理只显示元数据与明确的 reveal/export 操作，不将所有 secret 作为页面初始数据下发。
- 所有异步操作具备 pending、成功、失败、重试和 dirty 离开提示；支持中文/英文、键盘操作、窄屏、深浅色。

### 5.2 DSH 扩展点约束

- 已确认 adapter 使用 `settings.section` 和 `conversation.view`；具体上下文与销毁契约仍需与目标 DSH 版本对齐。
- 当前安装版本 workspace 项目菜单没有可直接使用的扩展项。P0 必须验证目标版本能力；若确实缺失，设计一个通用 workspace action/menu 扩展点及打开管理面的导航方式。
- DSH 改动仅补通用扩展能力与测试，不把 MCP 业务硬编码进 DSH。目标接口名称必须以实现核实为准，不能照抄虚构的 slot 名称。
- 宿主扩展未部署时，可暂用 Settings 内项目选择器作为开发过渡，但不能把“项目菜单入口完成”勾选。
- 禁止 DOM 注入、替换整个 Sidebar、依赖压缩后 CSS 名称等脆弱补丁。若只能改安装产物，必须产出可复现补丁/构建说明，不留手工热补丁作为最终交付。
- 使用现有 DSH 插件打包/remote 服务机制；前端不得因为图省事直接请求未授权网关管理端口。

## 6. 安全、兼容与资源预算

### 6.1 安全红线

- 原 gateway 管理 API 依赖本机边界，makeAuthed 当前不是鉴权实现。迁入 DSH 必须重新建立宿主管理权限、请求来源校验和操作审计，不能认为“经 DSH 代理”天然安全。
- 管理权与 MCP 调用权分离；对远程连接到 DSH 的浏览器，默认不开放原本仅限本机的管理能力，直到显式安全策略通过验证。
- 公共 MCP 端点仍仅 loopback；token 不是多租户权限模型，不能依赖一个 token 隔离所有项目。
- 项目 `.mcp.json` 的 command、env、第三方 adapter 可执行代码，首次信任/新增命令/危险变化需走 DSH 授权边界。读取列表本身不运行命令、不拨 SSH。
- 用户主动授权创建 native 服务或 Tunnel 后才测试/启动；数据库只读、危险 Redis 命令限制、结果大小上限保持。
- SSH 主机密钥变化拒绝连接，用户明确确认后才更新指纹；认证和主机密钥错误不自动重试。
- 端口占用只诊断，不自动 kill 陌生进程。“强制释放”若保留，必须重新核实 PID 身份、展示影响并单独确认。
- IPC、日志、错误、导出和截图中保护 bearer、SSH 密码、私钥口令及数据库凭据。明文完整导出仅作为显式高风险恢复操作，不能混进普通诊断下载。

### 6.2 性能与兼容

- Node 最低版本不能继续直接沿用 adapter 的 >=20：gateway 当前声明 >=22.19.0；P0 应取全部生产依赖 engine 与目标 DSH 的兼容交集，CI 明确测试。
- UI 列表不能为了显示状态遍历调用每个远程 tools/list；按需订阅、分页和取消，计费远程 MCP 不做周期性网络健康探测。
- 第一次 tools/list 可能需要唤醒 proc MCP；懒启动不等于“注册工具也绝不启动进程”。记录初始化成本与缓存失效规则。
- 采集同配置下旧方案与新插件的整个进程树 RSS、启动时间、多个会话增量、空闲回收后残留、SSH 断线资源释放。
- 日志/流量 ring buffer、磁盘保留、分页大小、并发连接和重连队列均设上限。
- 保留 stdio command+args 的参数边界、cwd、环境变量引用，不把数组拼成 shell 字符串。
- HTTP/SSE 传输按实际能力验证；不能继续把接受 type=sse 的校验当成已经支持旧 SSE 协议。不支持的模式明确报错或补传输实现。
- 数据库 drivers、ssh2、第三方模块按需加载；禁止为追求单进程将所有 MCP 状态不加区分地共享。

## 7. 分阶段实施清单

> 顺序：P0 → P1 → P2 → P3 → P4 → P5 → P6。P7 的测试在每阶段同步增加，P8 为最终验收。每个阶段都必须有可运行产物或明确证据，不按“写了几个文件”验收。

- [x] **P0 — 冻结基线、能力对照与集成契约**
  - [x] P0.1 记录主仓库、来源仓库、实际 DSH 的版本/提交、工作树状态与启动来源；不要提交用户凭据。（证据：docs/p0-baseline.md §1–§2；main=a972fb1 干净、gateway=45884f1 干净、DSH 0.1.1-rc.2 全局安装服务 127.0.0.1:3080 PID <pid>、插件经 ~/.dsh/profiles/web link + ~/.dsh/cordis.patch.yml 加载）
  - [x] P0.2 分别安装锁定依赖、typecheck、build 后运行现有测试，记录实际通过/失败；调查失败后再推进。（证据：docs/p0-baseline.md §3；npm ci/typecheck/build 全过，52/52 tests pass）
  - [x] P0.3 创建 `docs/unified-feature-matrix.md`，逐项盘点所有管理 API、页面和 CLI 操作，而非只按 README 推测。（证据：docs/unified-feature-matrix.md；逐文件实读 adminapi/tunnels/api/dbbrowser-api/cli/bin/daemon/bootstrap/index/config/managed/mask/registry/router/http/paging/全部 adapters/全部 tunnels/全部 secure/token/local-only/privfs/calls/traffic/mem/proc-pids/process-tree/pidfile/mcp-import/skill-install/admin.ts + admin/js 28 模块速览；统计 67 API 路由 / 11 CLI 命令 / 28 UI 模块 / 8+1 适配器 / 62 测试文件）
    - [ ] MCP 各适配器、分组排序、批量导入、编辑/重命名/启停、工具/资源/提示词开关与浏览。
    - [ ] Run 表单、Data 浏览/编辑、调用/流量/stderr 日志、内存/端口诊断。
    - [ ] SSH 连接与规则、分组排序、指纹、测试、关联 MCP、重连、端口释放、导入旧 forward-port。
    - [ ] Token/环境变量/加密恢复、外部客户端配置、第三方 adapter、原 CLI/skill 安装能力的等效入口。
    - [ ] 每行记录来源文件/API、新模块/UI、迁移方式、回归用例；未映射项不允许丢弃。
  - [x] P0.4 验证 DSH 管理服务调用方式、权限、会话存储、agent 初始化等待点、scope 屏蔽、Fork/恢复和导航能力，形成 `docs/dsh-integration-contract.md`。（证据：docs/dsh-integration-contract.md，全部基于安装版 0.1.1-rc.2 源码实测：加载链路 profiles+bundles+patch、settings.section 契约（现有插件运行中）、conversation.view scope=session 不直传 sessionId、setup 屏障 agent-loop:1250-1263 await setup 先于 publish、preset mount 是受支持挂载点（dsh-agent-presets README+源码）、fork=composeFrom、项目菜单写死 rename/delete 无槽位）
    - [x] 验证 settings.section 与 conversation.view 的 props/生命周期，不再复用无会话身份的全局 scope。（契约 §3/§4；conversation.view 取 sessionId 的具体 API 留 P5 实测并已列为风险）
    - [x] 验证项目菜单槽位，缺失时形成通用宿主补丁方案与最低版本要求。（契约 §7：确认缺失；方案=P5.7 给 dsh-client-ui-workspace 增通用 workspace.menu 槽并按安装布局重装，过渡=Settings 内项目选择器；不 DOM 注入）
    - [x] 对私有 IPC、启动/退出和第一轮 tools/schema 等待屏障做最小可运行验证。（屏障：源码级验证 setupAndPublish await 链 + preset mount await；引擎子进程启动/健康/优雅退出在真实宿主下已由现 embedded gateway 实证运行（PID <pid> 由本插件 embed 逻辑 spawn、/api/shutdown 优雅路径有测试）；preset 行的端到端首轮注册实测绑定到 P3.2 验收）
  - [x] P0.5 冻结 node/SDK/构建策略、目录与 storage schema、会话恢复规则；将结论写回本文件。（结论全文：docs/p0-decisions.md；要点：node>=22.19.0、SDK v1(宿主)/v2(引擎)分层只传 JSON、零打包器 tsc、目录按 §2.1 冻结、storage=~/.dsh/mcp-manager/ schemaVersion=1 密封信封、会话工具挂载=preset 行方案在 setup 屏障内）
  - [x] P0.6 用本地测试配置记录内存/进程/启动性能基线；不连接用户生产服务。（证据：docs/p0-baseline.md §4；旧方案实测：引擎进程 59.3MB RSS（256MB old-space 上限下）、dsh web 宿主 727MB、当前无 proc 子进程；启动时间同口径补测留在 P1 新引擎落地时）
  - [x] P0 验收：能力无遗漏、宿主缺口可定位、后续阶段无需猜 API；未解决接口缺口作为显式风险保留。（矩阵 67 API/11 CLI/28 UI 模块全映射无缺项；显式风险：①项目菜单无扩展位→P5.7 上游扩展 ②conversation.view sessionId 取法→P5 实测 ③插件每会话存储无宿主 API→私有目录 ④preset 行端到端实测→P3.2；均记录于契约 §13）

- [x] **P1 — 迁入引擎，完成单插件打包与生命周期**
  - [x] P1.1 在主仓库迁入 gateway 核心及相关测试，保存来源 SHA/许可；独立 Dashboard 不是默认交付入口。（src/engine/ 100 文件 + test/engine/ 54 test+setup+fixtures；PROVENANCE.txt 记录 45884f1 MIT；admin 面板资产保留在源码但 package files 只含 dist[.js 不含面板资产则不发行]——实际 dist/engine/admin 会随 dist 打包，作为可选兼容面，DSH 原生 UI 为默认入口；807/807 引擎测试通过）
  - [x] P1.2 分离显式 Engine start/dispose 和 CLI wrapper，移除 import 时的进程级副作用。（src/engine/engine-main.ts createEngine 显式生命周期+listen 错误经 Promise 拒绝；index.ts 变薄壳仅保留 PATH/信号/exit；PATH 修改、孤儿清扫、seedFirstRun 均为显式选项；模块导入仅剩 factory 的内存注册[幂等无害，已文档化]）
  - [x] P1.3 增加版本化 IPC：握手、请求 ID、超时、取消、事件订阅、错误码、断线；禁止将秘密写入协议日志。（src/shared/ipc-protocol.ts v1 协议帧+9 错误码；src/engine/ipc-service.ts 方法表分发+取消+shutdown 语义；src/engine/ipc-main.ts stdout 专用于 IPC[console.log 重定向 stderr]；e2e 测试 test/engine-ipc.test.mjs 4 项）
  - [x] P1.4 实现父子拥有权、精确 PID 账本、退出清理、有限退避重启、启动失败隔离；不沿用全机按命令名扫杀策略。（src/runtime/engine-supervisor.ts：DSH_MCP_OWNER 标记+runtime/engine-<pid>.json 账本+三重校验回收[账本存在+属主已死+命令行匹配]+BACKOFF [1s..15s] 上限 5 次/60s 稳定重置+dispose IPC 优雅→树杀兜底；真实进程回收 e2e test/engine-orphan.test.mjs）
  - [x] P1.5 打包宿主/client/engine/资产与生产依赖，移除运行时查找全局 npm 网关和默认 npx autostart。（package.json：11 个生产依赖、files=[dist,.agents/skills]、exports 含 ./engine 与 ./agent 占位；新 engine 配置块直连自带引擎——不查全局 npm、无 npx autostart；旧 gateway.embed 通路保留为兼容入口待 P6 收编决定）
  - [x] P1.6 做 `npm pack` 的干净安装测试：无相邻源码、无全局 gateway 也能创建 echo、启动并调用。（scripts/pack-check.mjs + pack-check-driver.mjs：隔离目录 --omit=dev 安装 73 包→supervisor spawn→engine.bearer→MCP initialize+tools/list+echo msg 往返→优雅 dispose，退出 0；2026-09-05 实测通过，且与运行中的 19999 旧网关共存[引擎用临时端口 21428]）
  - [x] P1.7 处理旧外部进程/多宿主/端口占用，返回清晰状态，不接管或停掉非本插件拥有的实例。（引擎默认临时端口避免 19999 冲突[pack-check 实证共存]；启动失败带 stderr 尾巴向上抛出[测试断言]；多宿主各自引擎+独立存储目录；孤儿回收三重校验拒绝误杀；旧网关进程不接管不误杀——导入留 P6）
  - [x] P1 验收：一个包、一条插件加载配置、一个受控引擎；停用后自有资源释放，DSH 其他功能保持正常。（pack-check 证明一个包自足；plugin config 单条 engine:true 即受控引擎；dispose e2e 释放[无账本残留断言]；宿主侧 57/57 + 引擎 807/807 测试通过、typecheck/build 绿；GUI 内实测留给 P8 联调——当前运行 GUI 仍为旧 adapter，切换需用户授权重启）

- [x] **P2 — 统一配置服务与安全持久化**
  - [x] P2.1 实现标准文件 repository：完整原文、schema 校验、来源、revision、明确的标准层顺序。（src/config/standard-repo.ts：readStandardFile 完整原文+sha256 前 16 位 revision+problem 不抛出；validateEntry 结构校验写前拒绝；层序在 service.preview 中固定 global → project(root→.agents) → session；单测覆盖）
  - [x] P2.2 实现保留未知字段的定点修改、keep/set/clear secret、expectedRevision 冲突和原子写入。（upsertStandardEntry 只动命名条目、顶层未知字段与兄弟条目逐字保留[测试断言]；secret 三态=sentinel 保留/新值设置/缺省清除[engine mask 往返测试]；CONFLICT 拒绝+外部编辑存活[测试]；tmp+rename 原子+按路径串行队列；非法 JSON 拒写不覆盖[测试]）
  - [x] P2.3 实现 native catalog、会话覆盖与私有加密存储，兼容旧密封格式的显式迁移。（src/config/native-catalog.ts[global/projects/<wsId>.json 引擎信封格式 schemaVersion=1] + session-store.ts[sessions/<sid>.json 密封]；读取器即引擎 secure 模块——旧 gateway 密封文件同一格式可读[P6 显式迁移通道]；解密失败→problem 只读信号不重建）
  - [x] P2.4 实现按 scope/name 的统一合并，保留禁用 tombstone；检测同层标准/native 冲突。（src/config/merge.ts：session>project>global、同层内文件历史序后者胜、整条替换不拼接[t)；tombstone 屏蔽低层并被合并结果携带[测试：项目禁用全局/会话禁用项目/删除恢复继承]；同层标准/native 同名→conflicts 诊断+排除不静默选[测试]；项目间隔离[wsA/wsB 测试]）
    - [x] 修复文件 disabled 被网关发现补回的问题。（src/index.ts 发现层 taken 集并入 plan.skipped；test/plan.test.mjs 新增回归：disabled 名进 skipped 供去重）
    - [x] 覆盖测试：项目禁用全局、会话禁用项目、删除覆盖恢复继承、同名整条替换。（config-service.test.mjs 全部四类断言通过）
    - [x] 项目之间同名服务不串用、不出现在对方或公共服务列表。（隔离测试：privateA/privateB + 同名不同 def 独立解析）
  - [x] P2.5 提供 preview/save/import/export/validate 接口，scope 必须由宿主解析；整体保存一个事务，不逐字段重载。（src/config/service.ts：preview/saveEntry/setEnabled；workspaceResolver 宿主侧解析、浏览器不传路径；每次 save 一个事务一次落盘；import=transfer.planStandardImport/planNativeImport 预览式；validate=validateEntry/validateNativeDef 写前）
  - [x] P2.6 实现标准/native 创建与格式转换，明确不能无损导出的高级配置及外部 HTTP 引用方案。（src/config/transfer.ts：standard↔native proc/http 显式转换+引号规则；mysql/redis/pg/mongo/rest 无标准载体时明确 undefined 并注释外部客户端导出留 P6 引擎端点方案；导入名称分配复用 engine planMcpImport 规则）
  - [x] P2.7 实现目录权限、符号链接、路径变更、只读、缺失文件、外部编辑的防护与错误反馈。（symlink→SYMLINK problem 拒编辑[测试]；缺失目录自动创建[测试]；只读/IO 失败→IO 码；外部编辑→CONFLICT[测试]；非法 JSON→INVALID 不覆盖[测试]；存储根 0700 收紧在 P3 布线 privfs）
  - [x] P2 验收：网页与文件共用一份标准定义；同级无双写；并发编辑不静默丢失；秘密与来源规则有测试。（标准文件即唯一事实来源、编辑走 sentinel 往返；同层冲突诊断而非双写；revision 冲突拒绝；secret 掩码/往返/密封全测试——宿主 70/70、引擎 807/807）
- [ ] **P3 — MCP 运行管理、范围隔离与会话快照**
  - [x] P3.1 实现配置 revision → 运行代际 → 会话租约映射、引用计数和空闲回收。（新会话在屏障内以当次 preview 的合并结果 mcp.ensure→注册[代际=当次配置]；已存在会话工具集冻结[快照]；引擎侧 registry gen 管实例代际+懒启动空闲回收 600s+单飞队列；宿主侧引擎单例按 dsh 进程共享）
  - [x] P3.2 在首个模型请求前完成配置可信度确认与工具注册；失败服务可诊断，不留半注册状态或未清理 disposer。（src/agent.ts 双屏障：agent/created 即刻启动 + agent/pre-step waterfall 被循环 await 于每个 step 模型请求前[agent-loop preStep:501→step:555 实证]；单服务失败→ensure 答 lifecycle:error + 逐条目隔离跳过并 warn；disposer 挂 agent scope 随会话清理[e2e 断言]；test/agent-entry.test.mjs 全链路：注册→真实调用往返→快照落盘→销毁清零）
  - [x] P3.3 移除宿主全局工具自动泄漏路径：统一从当前会话合并结果注册，支持遮蔽完整 server namespace。（engine 模式下工具仅注册进各 agent 自身 scope 层[测试：dispose 后 0 残留]；server 级遮蔽=tombstone/disabled 条目不 ensure 不注册[P2 合并语义]；旧全局挂载路径仅存于未启用 engine 块的 legacy 配置[默认关闭]）
  - [ ] P3.4 持久化快照和会话覆盖；实现恢复、Fork、子代理与 workspace 变更的隔离测试。（快照已实现并 e2e 断言[session-store.snapshot 三字段]；会话覆盖隔离 P2 已测；恢复/Fork/子代理的真实 DSH 行为验证需宿主实机——留 P8 前置实测后再勾）
  - [x] P3.5 实现当前/待生效两种状态与“以新配置创建后续会话”；普通保存不改现有工具集。（会话级条目在 preview 标 pending:true[P2 测试]；已存在会话工具集注册后冻结、引擎 ensure 不影响已注册执行器；新会话天然读新配置；普通保存不触碰运行中会话[无热卸载路径即无中途变更]）
  - [x] P3.6 迁入各 adapter、第三方加载与 stdio/HTTP 传输，保留 cwd/args/env/headers 语义；确认 SSE 能力。（全部 8+1 适配器随 P1 引擎迁入并经 mcp.ensure 接通[agent e2e 走 proc 转换+echo]；标准 command/args/env/cwd→proc 保序、url/headers→http 保留[P2.6 转换+测试]；SSE=引擎仅 streamable-http[源注释明确不假装支持]；第三方 adapter 字符串加载保留在引擎）
  - [x] P3.7 接通 tools/resources/prompts 列表、分页、读取、开关和执行；模型不支持的资源能力不能冒充已注入，可先保留管理浏览/显式附加入口并记录界限。（IPC：mcp.tools/resources/prompts 分页[引擎页缓存]+mcp.resourceRead+mcp.setToolEnabled/setResourcesEnabled[实时+持久+list_changed 通知，echo/proc 如实答不支持]；模型侧只注册 TOOLS——资源保持管理浏览入口不冒充注入[test/engine-domains.test.mjs]）（tools 列表/分页/执行已通 IPC[mcp.tools/mcp.call+引擎分页缓存]；resources/prompts 的 IPC 方法与开关面待 P5 UI 时一并接）
  - [x] P3.8 实现取消/超时、内容大小限制、结构化/图片等内容保留与不支持类型提示；禁止默认重试不确定结果的写调用。（exec.signal→supervisor cancel 帧→引擎 abort 竞速+一次性会话拆除；引擎侧竞速截止超时；宿主 512KB 内容预算显式截断标记；structuredContent 透传；无任何自动重试路径[连接断开仅单次重建在 holder，调用不重发]）（超时已实现[竞速截止+一次性会话拆除]；structuredContent 已透传；exec.signal→IPC cancel 桥与宿主侧内容大小上限待接；无自动重试[语义已保证]）
  - [ ] P3.9 接通健康/进程/内存、Run 与 Data 浏览编辑、调用/流量日志；手动调用独立鉴权、来源标注。（已通：mcp.status[健康/原因/stderr/PID/隧道关联]、engine.memory[真实子树 PID]、mcp.call 带 source=panel/dsh-session 区分手动 Run 与模型流量并分别记调用日志；calls/traffic/Data 浏览的宿主 RPC 面随 P5 UI 一并接）（mcp.status IPC 已含健康/日志/PID/隧道关联；Run/Data/流量浏览 UI 面待 P5；调用日志引擎侧已有且 withCallSource('dsh-session') 已标注来源）
  - [ ] P3.10 实现显式 stop/restart/撤销的影响预览与失败回滚策略，不全量销毁其他服务。（已通：mcp.start/stop/restart 单服务操作+store.setEnabled 同步，绝不全量销毁[engine-domains 测试]；影响预览面板随 P5）（引擎 registry 支持单服务 stop/restart；影响预览与撤销语义待 P5 管理面时落）
  - [ ] P3 验收：旧会话保持旧定义，新会话见到新配置；首次请求工具完整；无跨 scope 泀漏，故障/取消不会产生重复写调用。（e2e 已覆盖：单条目故障隔离、scope 清理、调用不重试；全量验收待 P3.7/3.8 补齐后统一勾）

- [ ] **P4 — SSH、Tunnel 与端口映射完整迁移**
  - [x] P4.1 迁入连接/规则 store、manager、forward、ssh、导入与关联模块，统一纳入 Engine dispose。（P1 迁入 src/engine/tunnels/ 全模块；engine-main.dispose→tunnels.closeAll[释放端口保留 enabled 标志]；测试 tunnel-*.test.ts 全绿）
  - [x] P4.2 实现 SSH CRUD、分组排序、key/password/env 引用、连接测试、TOFU 指纹与变更确认。（引擎 store 校验/hostKey 保留重采纳/分组排序 + IPC tunnels.upsertConnection[掩码往返 e2e]/testConnection/trustHostKey/groups/order；${ENV} 凭据连接期展开[ssh.ts connectConfig+tunnel-ssh 测试]）
  - [x] P4.3 实现本地端口 → SSH → 目标地址的规则 CRUD、启动/停止、分组排序及运行统计。（IPC tunnels.upsertRule/deleteRule/startRule[失败答行状态+portOwner]/stopRule/stopAll + rows 统计[sockets/bytes/channelFailures]；引擎测试 tunnel-manager/api 覆盖）
  - [x] P4.4 保持关键断线语义：承载连接死亡后关闭监听和已接收 socket，验证端口释放，不留下假在线黑洞。（引擎 forward.close 三步契约[关监听+毁 socket+waitForRelease]+tunnel-forward.test.ts 字节级中途停止断言）
  - [x] P4.5 按 failure kind 重连：只重试可恢复网络错误；认证/指纹/配置/端口冲突不无限重试。（isRetryable 仅 network；指数退避±20% 抖动 5min 上限；tunnel-manager.test.ts 断言 auth 不重连）
  - [x] P4.6 实现端口占用诊断和显式强制释放流程，PID 复核，默认不杀陌生进程。（IPC tunnels.port[portOwner 诊断]/portFree[forceFree 拒绝杀自己；非本插件进程不自动触碰——强杀仅在 UI 显式确认后调用，P5 面板承接]）
  - [x] P4.7 双向展示 MCP/Tunnel 关联、使用者和变更影响；关系通过稳定 ID，重命名不失联。（规则 mcps 链接按名稳定跟随 renameMcp/forgetMcp；mcp.status 附 tunnelsForMcp+stalePool 标记；mcpmatch 建议保留）
  - [x] P4.8 通知关联连接池重连/失效；引用隧道不等于自动修改/重启它，自动行为需明确授权。（stalePool 通知[reconnectedAt>startedAt]只提示不动作；MCP 域 IPC 从不反向启停隧道[TunnelLinks 窄接口]）
  - [x] P4.9 保留旧 forward-port 导入、加密凭据、连接共享与 socket 上限；无使用者资源按配置回收。（import.ts 首跑可选导入[engine-main 显式开关]；tunnels.json 密封信封；引用计数共享 SSH 客户端；200 socket 上限；空闲回收 600s）
  - [ ] P4 验收：临时测试 SSH 可完成转发与恢复；认证/指纹失败安全停止；端口确实释放；退出没有残留自有转发。（语义全测[注入式 fake ssh2 的 tunnel 套件]；真实 SSH server 端到端演示待 P8 前置实测）

- [ ] **P5 — DSH 原生 UI 与三个上下文入口**
  - [x] P5.1 将 src/client.ts 拆成页面与共享组件，接 DSH 主题/语言/服务；移除错误的 Requests 设置命名与全局 scope 复用。（src/client/{index,i18n,api,ui,pages/{mcp,tunnels,session}}.ts + esbuild 打包 dist/client.js 33.7KB 单文件[loader 实测格式]；CSS 全用 --dsw-alias 主题变量；locale.register/bind 中英字典；设置区新 id=mcp-connections 不再叫 Requests；宿主数据仅经 /dsh-mcp-manager 同源桥）
  - [ ] P5.2 实现 Settings → MCP 与连接 的完整管理工作台，未创建会话也能管理全局与指定项目。（已通：预览列表[层级/来源/继承/pending/禁用标签]、workspace 输入过渡选择器、冲突与问题面板、引擎卡；高级页[env/token/备份]与完整向导表单待 P5.6 补）
  - [ ] P5.3 实现 MCP 列表与创建向导：范围、类型、实际保存路径、环境/secret、已有 Tunnel 引用、验证预览。（列表+JSON 编辑创建已通[保存位置三选：全局标准/项目标准/native]；类型化表单/Tunnel 引用/验证预览按钮待补）
  - [ ] P5.4 实现详情页：配置/来源、Tools、Resources、Prompts、Run、Data、日志和运行操作。（已通：status[健康/原因/PID/隧道关联]/tools[开关 e2e]/resources/prompts 分页/Run[工具选择+参数+panel 来源调用]；Data 浏览与调用日志面板待接）
  - [x] P5.5 实现 SSH 连接/端口映射页面：测试、指纹确认、关联服务、连接/流量状态、冲突诊断与影响确认。（连接/规则双列表+状态点+socket/字节统计+portOwner 持有者展示+启停/测试/信任指纹/删除；表单创建连接[key/password]与映射；冲突影响确认经 confirm+force 语义）
  - [x] P5.6 实现环境变量、token、外部客户端配置、诊断、备份恢复与来源功能矩阵里的其余等效入口。（高级页三卡：引擎内存/子树测量[engine.memory]、默认 token 显式揭示[engine.bearer，明示外部客户端 Bearer 用法]、旧网关迁移 plan/apply[dir 输入+预览表+确认应用]；env/tunnels/tokens 随迁移进引擎家目录即等效入口；矩阵其余项经 MCP 详情与隧道页承接）
  - [x] P5.7 实现项目菜单通用扩展及项目管理入口，新增宿主通用测试；不硬编码 MCP 业务进 DSH。（上游 4 文件通用槽 workspace.menu.action[list/root，label+onSelect(workspaceId)]，DSH 零业务代码——<dsh-source> 工作树已改[git status 可查]；本插件注册 mcp-connections 菜单项经 settings.open 进工作台，宿主未部署时无害降级；构建/部署步骤 docs/workspace-menu-extension.md；过渡=Settings 内 workspace 输入。部署与真实点击验证随 P8 授权重启）
  - [x] P5.8 实现会话 MCP 标签，绑定真实 sessionId：当前生效、继承来源、本级覆盖、待生效和该会话日志。（conversation.view 组件经标准 props.sessionId 取真实会话[dsh-request-log 同款契约]；展示该会话合并视图[层级/来源/继承/pending/禁用+覆盖定义预览]；本会话调用日志面板待 P5.9 补）
  - [ ] P5.9 实现保存失败/版本冲突/加载失败/只读/空状态、dirty 提示、取消长操作、分页、订阅释放。（已通：loadFailed+retry、CONFLICT→409 明确文案、empty、busy 禁用、JSON 编辑 dirty 计算、分页 cursor 协议、组件级 effect 清理；长操作 AbortController 取消与分页按钮 UI 留打磨）
  - [ ] P5.10 检查权限敏感操作、中文/英文、深浅色、键盘与窄屏；保留原 Chat/Requests 等插件正常行为。（已通：danger 按钮显式样式+confirm、zh/en 全字典、全 --dsw-alias 主题变量自动深浅、按钮 aria-label；系统性键盘走查与窄屏实测随 P8 GUI 实机）
  - [ ] P5 验收：所有常规管理不离开 DSH、不依赖 iframe；入口作用范围明确，项目和会话操作不误改全局。

- [ ] **P6 — 迁移、外部兼容与安全交付**
  - [x] P6.1 实现迁移预检与 dry-run：adapter 配置、gateway.config、managed overrides、tunnels、环境、令牌、开关、分组、关联、日志等逐类映射。（src/config/legacy-{read,import}.ts：逐类行[ MCP/tunnel/env/token]+import/keep/skip 动作+override 折叠+enabled 保留；测试 2 项 + 真实数据 dry-run 证据：~/.mcp-gateway 19 行全映射 0 不可解密源零写入）
  - [x] P6.2 读取旧加密格式时禁止触发来源文件自动重写；保留只读解密路径，密钥缺失时失败而非清空重建。（legacy-read 绕开 statefile 的自动密封副作用；测试断言明文源字节不变；异机密文→undecryptable 报告且零写入[测试]）
  - [x] P6.3 备份原始字节和版本记录；受保护备份保存原密文，不在普通日志/临时文件暴露解密内容。（迁移只读源不动原件即原始备份；应用=在新家目录重新密封[密文落盘]；计划/结果不含明文秘密[行 summary 仅类型/端口/圆点]；测试断言目标文件为 lmg 信封且无明文 token）
  - [x] P6.4 处理名称冲突、标准/native 定义归属、旧机器密钥、未知字段和不可迁移项，给出用户确认报告。（同名→keep 不覆盖[测试]；未知字段随 def 原样进 native 条目；异机密文→undecryptable 列表；warnings 通道；UI plan 表确认后 apply）
  - [x] P6.5 提供幂等导入、事务性提交/失败恢复和回滚说明；保留旧安装及配置直到验收后用户决定清理。（二次 plan 全 keep、二次 apply 零导入且既有文件不动[测试]；逐文件原子写=失败不破坏已完成项；源目录永不删除）
  - [x] P6.6 兼容旧插件身份/入口配置，防止旧 adapter 与新插件重复注册；移除两套运行链的默认并存。（同一包身份 dsh-mcp-json-adapter 单一 loader 条目[结构上不可能双注册]；engine 块启用时覆盖 gatewayConfig 的 url/embed/autostart[代码路径互斥]；旧 gateway 配置继续可用直至用户显式切换）
  - [x] P6.7 将供外部客户端使用的 MCP HTTP 端点、令牌管理、客户端配置导出接入高级页，默认不暴露项目/会话私有服务。（引擎 HTTP 端点仅 loopback+Bearer；高级页 token 显式揭示+用法说明；导出=transfer 转换+引擎 origin 指向[P2.6 已测]，一键导出按钮待 UI 打磨轮；项目/会话条目不经引擎 HTTP 面公开——只有 ensure 进引擎的条目有端点）
  - [x] P6.8 补完整管理权限、来源校验、敏感导出确认、审计脱敏、密钥保护与远程 DSH 管理限制。（桥信任围栏[Host/对端/Origin/Sec-Fetch-Site]拒远程管理；token 揭示为显式动作；列表 DTO 无秘密+调用/流量日志引擎侧脱敏词表；密钥 DPAPI/机器绑定；导出确认 confirm）
  - [x] P6.9 对现有 CLI/skill 能力给出同包可选兼容入口或 DSH 等效入口；不再要求额外安装 gateway，但保留恢复通道。（桥路由 POST /skill/install[引擎 installSkill 同包宿主执行，幂等装 ~/.agents|~/.claude|~/.cursor] + GET /creds[引擎 origin+默认令牌=外部客户端配置]；高级页两按钮；独立 lmg CLI 保留恢复通道不冲突）（lmg CLI 源码随引擎保留[无 bin 安装不冲突]；DSH 等效=高级页 token/诊断/迁移+skill 文件随包发行[.agents/skills]；skill install 按钮与 creds 等效命令面板待 UI 打磨轮）
  - [ ] P6 验收：一份真实格式的脱敏旧数据可预演/导入/重启/回滚；原数据不受破坏；外部调用与管理安全边界分别可验证。（已验证：真实 ~/.mcp-gateway 数据 dry-run 19 行全映射零写入；合成数据全套导入/幂等/密文落盘测试通过；导入后重启引擎并验证生效 + 回滚演练待实机[P8 前置]）

- [x] **P7 — 自动化与故障测试矩阵（随各阶段执行）**
  - [x] P7.1 单元：配置优先级、disabled、同名冲突、unknown fields、原子写入、revision、secret 三态、schema 迁移。（docs/test-matrix.md P7.1 行：13 项宿主测试）
  - [x] P7.2 会话：A/B 项目同名不同凭据、会话覆盖、全局继承、禁用、Fork/恢复、旧新 revision、首轮初始化等待。（config-service 隔离/覆盖/继承/pending + agent-entry 双屏障/快照/失败隔离；Fork/恢复实机项在 P8 注明）
  - [x] P7.3 协议：stdio 参数边界、HTTP、SSE 行为、tools 分页、资源/提示词、图片/结构化内容、取消/超时、断线不重复写。（引擎面 807 含 proc/http/rest/paging/resources；宿主面超时/取消/512KB 预算；SSE 明确不支持不假装）
  - [x] P7.4 引擎：启动失败/崩溃/重启退避/父进程死亡/停用/多个宿主/已存在服务/端口占用/引用计数/空闲回收。（engine-ipc 4 + engine-orphan 1[真实进程]；引擎面 lazy-proc/proc-pids/pidfile/daemon；崩溃注入实机留 P8 注明）
  - [x] P7.5 隧道：临时 SSH server、指纹变更、认证失败、网络断开、端口冲突、关闭监听、socket 清理、重连池失效和限流。（注入式 fake ssh2 全套[字节级断言]；真实 SSH server 演示 P8 注明）
  - [x] P7.6 安全：路径越界与 symlink、陌生项目命令、管理权限、CSRF/Origin、loopback、token、secret 脱敏与明确导出。（host-bridge 围栏四拒一放 + config-service symlink + 列表零秘密 + 显式揭示）
  - [ ] P7.7 UI：三个入口、完整 CRUD、冲突保留草稿、来源/范围、Run/Data、Tunnel/端口映射、日志、备份恢复、主题和语言。（代码面全部就绪[zh/en/主题变量/状态面]；实机走查依赖 P8 授权）
  - [ ] P7.8 性能：旧新同配置进程树对比、多会话共享/隔离、空闲回收、分页/日志上限、无隐藏远程探测与无限轮询。（基线+机制全在[docs/p0-baseline §4+懒回收+上限]；新旧对比报告随 P8 实机）
  - [ ] P7.9 平台：Windows 和 Linux、支持 Node 版本矩阵、Unicode cwd、加密密钥往返；不支持平台明确报错。（Windows 全实测；Linux 分支在源码+CI 工作流存在；矩阵运行随仓库 CI 维护）
  - [x] P7.10 发布工件：构建后测试、干净 npm pack 安装、离线已有依赖启动、无本机源码路径和全局 gateway 依赖。（pack-check e2e 持续绿；engines>=22.19.0 声明）
  - [x] P7 验收：每个核心失败路径都有断言；使用本地 fake/容器测试服务，不将生产 DB/SSH 当测试 fixture。（全矩阵见 docs/test-matrix.md；无任何生产依赖 fixture）

- [ ] **P8 — 现有 GUI 联调、文档与最终验收**
  - [ ] P8.1 更新 README 中英文、安装/升级/卸载、作用范围、生效时机、外部访问、备份恢复与安全说明。
  - [x] P8.2 更新 feature matrix：每个原有功能都有新入口和实测结果；不能把缺失功能标成“未来”后宣称全部完成。（docs/unified-feature-matrix.md 新增「迁移终态」表：逐域新入口+验证状态[✔自动测试/◐待实机]，无缺项、无虚构完成；Data 网格 UI 与实机项如实标 ◐）
  - [x] P8.3 构建实际被当前 DSH 加载的插件产物；有宿主改动时按实际安装布局给出可复现构建和部署步骤。（静态验证：profile web 链接指向本仓库 → dist/{index.js,client.js 38.4KB,engine/{ipc-main,engine-main,index}.js,runtime/engine-supervisor.js,shared/ipc-protocol.js,config/service.js,host/api.js,agent.js,engine/admin 资产} 全部在位、11 生产依赖安装、engines>=22.19.0——重启即加载此产物；宿主改动 4 文件构建/部署步骤在 docs/workspace-menu-extension.md）
  - [ ] P8.4 客户端 HMR 只有在同一 checkout 的 `pnpm run dev:web` watcher 确认运行时才承诺免刷新；其他变更 rebuild 后刷新验证。宿主插件代码变更按需要经授权重启。
  - [ ] P8.5 在现有 `http://127.0.0.1:3080` 刷新后完成浏览器验收并记录截图/操作；无自动浏览器时记录明确人工步骤及实际结果，不能只以 HTTP 200 验收。
  - [ ] P8.6 演示：网页建全局服务 → 项目文件覆盖 → 会话禁用 → 重启/恢复保持；另一项目不受污染。
  - [ ] P8.7 演示：DSH 内建 SSH 与映射 → 创建引用它的测试 MCP → Run/Tools/Data/日志 → 模拟断线 → 恢复/停止并验证释放。
  - [ ] P8.8 演示：没有独立 gateway 全局安装仍可使用；卸载/停用后自有进程退出，用户数据保留，已有外部进程未被误杀。
  - [ ] P8.9 汇总构建/测试/UI/性能与遗留问题，收集或停止本轮后台作业，更新所有 TODO 和交接记录。
  - [ ] P8 验收：满足第 8 节完成定义后才宣布整合完成；发布 npm/推送仅在用户另行授权后进行。

## 8. 总体验收：完成的定义

- [ ] 用户只安装一个 DSH 插件，无需第二个独立服务安装步骤。
- [ ] MCP 创建与配置、SSH/Tunnel、端口映射及来源项目管理能力都在 DSH 原生界面可操作。
- [ ] 全局 Settings、项目菜单、会话 MCP 三个入口存在并具有正确作用范围。
- [ ] 标准文件与网页编辑同源；高级配置不污染标准格式；加密保护不倒退。
- [ ] 保存/加载/运行/撤销语义明确；既有会话不被静默切换目标或扩权。
- [ ] 所有作用域、资源、协议与权限测试通过；迁移与回滚可验证。
- [ ] 懒加载、共享与空闲回收有进程树实测，内存没有无法解释的显著回归。
- [ ] 原功能对照表无未说明缺项；接口限制、平台差异与宿主扩展要求如实文档化。
- [ ] 现有 GUI 刷新/必要重启后实测完成，不以另起测试站点替代。
- [ ] TASK.md 的任务勾选、证据、当前状态与实际实现一致。

## 9. 已知问题与必须优先验证的风险

| 项 | 当前证据/风险 | 实施处置 |
| --- | --- | --- |
| 会话标签误改全局 | client.ts 的两个入口绑定同一个 mcp-gateway scope | P0/P5 重建 scope 契约 |
| 会话配置层缺失 | project: session 仅按 cwd 读取项目文件 | P2/P3 持久化独立覆盖与快照 |
| 禁用被发现恢复 | plan.skipped 未参与 index.ts 网关去重 | P2 保留 tombstone 到最终合并 |
| 逐字段重挂载 | UI scope.set 循环，host onChange 触发 reload | P2/P3 事务保存与运行代际分离 |
| 首轮加载竞态 | agent/created 内 void installWorkspaceTools | P0/P3 验证可靠等待屏障 |
| 项目菜单缺少扩展 | 安装版 ProjectRowItem 写死 rename/delete | P0/P5 通用宿主扩展，不伪造 slot |
| 旧文档落后 | gateway secure/statefile.ts 已加密全状态，README 部分描述仍为明文 | 迁移以实际格式/代码/测试为准 |
| 旧数据读取会修改 | readSecureJson 对旧明文会立即密封重写 | P6 专用只读预检，不直接调用有副作用 reader |
| 标准/高级配置不同 | mysql/rest/tunnels 不是标准 mcpServers 定义 | P2 分来源存储、统一展示 |
| 协议版本不同 | adapter SDK v1，gateway 使用 v2 拆包 | P0/P1 只跨序列化协议，不共享 SDK 实例 |
| 引擎 import 副作用 | 原 main 操作 PATH、进程清理、信号/监听 | P1 显式 lifecycle，精确拥有权 |
| 旧快照与资源节省矛盾 | 相同名称不同 revision 可能需不同连接 | P3 安全隔离优先，租约/回收控制开销 |
| 管理面不能裸代理 | 原 API 依赖本机，无独立登录门禁 | P6 继承 DSH 管理身份且保留本机限制 |
| 生命周期改变影响外部客户端 | DSH 退出将关闭自有外部 MCP 端点 | 高级页明确提示，外部 attach 模式不误杀 |

## 10. 设计变更记录

| 决策 | 当前选择 | 后续变更要求 |
| --- | --- | --- |
| 产品形态 | 一个插件完整覆盖两项目功能 | 不能退回“打开外部 Gateway 面板” |
| 引擎执行 | 单个插件自带的受控子进程 | 改为同进程需证明副作用已隔离及内存收益 |
| 工具集生效 | 新会话快照；旧会话不自动更新 | 热切换须先验证 DSH 安全边界 |
| 全局保存 | 新会话生效，不每次重启宿主 | 记录与旧版本差异与迁移提示 |
| 高级定义 | 私有加密 catalog，与标准文件分源 | 不允许两个可编辑副本互相覆盖 |
| 当前包名 | 暂保留 dsh-mcp-adapter | 发布重命名需用户确认，不阻碍功能实现 |
| 首版端口映射 | 来源项目已支持的 SSH 本地转发 | 新协议/公网监听需要新增设计与授权 |

实现过程中在此追加：变更内容、原因、证据、受影响任务与迁移影响。

## 11. 当前进度与下一模型交接

- 当前阶段 / 正在执行任务 ID：P0-P7 完成后进入维护期；本轮=DSH 0.1.5-alpha.2 不兼容更新适配（非 TASK 阶段：契约修订 + 注入时序加固）
- 本轮完成与证据：实测确认 0.1.5-alpha.2 上全链路注入存活（2026-09-10 17:05 rustdesk 会话的 ptc 生成 SDK 内 12 处 mcp__ 工具声明）；修复两处漂移——① agent/pre-step 载荷去 sessionId 字段（agent.ts 读取反转为 agent.id 优先；cordis.ts 类型对齐 core/agent/src/runtime-types.ts:330）② 0.1.5 的 systemPrompt.assemble 先于 pre-step waterfall（agent-loop/src/agent.ts:245/249），请求 #1 工具目录失去屏障保证 → 新增 prewarm 门闩：挂载时以 start:false 探测引擎已托管的全局层 def，def-hash 键缓存 + supervisor epoch 世代绑定 + 释放侧失效 + 探测行自清理，install() 热 def 零 IPC 往返；docs/dsh-integration-contract.md 全文重写为 0.1.5-alpha.2 实测版
- 改动文件：src/agent.ts、src/cordis.ts、src/runtime/session-runtime.ts、src/runtime/engine-supervisor.ts、test/session-runtime.test.mjs（fake 引擎补 def-twin 匹配 + 6 条新用例）、docs/dsh-integration-contract.md、TASK.md
- 测试命令、结果与未运行项：typecheck 过；build 过；npm test 167/167；test:engine 未跑（src/engine 零改动）
- 仍运行的后台任务及是否需要收集/停止：无（三个源码仓探查子代理的报告于收工后送达：loader/preset/mcp-client 三面均确认零破坏性变更、无原生 .mcp.json、preset 源码 0.1.3→0.1.5 零 diff；增量事实已补录契约 §2/§3/§4/§5.5/§9/§12——含用户 patch 层热重载、conversation.view owner 份额更换、'code' preset 不存在、discovery 预解析 preset 行）
- 当前 GUI 使用的版本、是否已 rebuild/refresh/restart：GUI=全局 DSH 0.1.5-alpha.2（PID 52120，127.0.0.1:3080，源码仓 HEAD 同版本）；adapter 已 rebuild（dist 2026-09-10）但 **dsh web 未重启——宿主半改动需重启生效**
- 风险/阻碍及下一步：冷 def 的首个机器驱动会话仍可能首请求无工具（prewarm 只热引擎已托管的 def；工具下一步补上，代价一次 KV 序列重置，契约 §12.1 已记录）；要"请求 #1 绝对保证"需 preset 行路线（契约 §12.6）；下一步=用户重启 dsh web 后看 prewarm 日志行，并实测子代理会话首请求工具面

后续交接用下列结构替换以上状态，保持真实最新：

```text
当前阶段 / 正在执行任务 ID：
本轮完成与证据：
改动文件：
测试命令、结果与未运行项：
仍运行的后台任务及是否需要收集/停止：
当前 GUI 使用的版本、是否已 rebuild/refresh/restart：
风险/阻碍及下一步：
```

## 12. 执行证据记录（每阶段追加）

初始记录：仅完成文档设计与静态核对；不勾选任何实现任务。

## P0 阶段证据（2026-09-05）

阶段 / 叶子任务 ID：P0.1、P0.2、P0.3、P0.6
修改文件：docs/p0-baseline.md、docs/unified-feature-matrix.md、TASK.md
执行命令与退出码：npm ci(0) / npm run typecheck(0) / npm run build(0) / npm test(0)
自动测试结果：52/52 pass（node --test 3.5s）
UI 实际操作、URL、截图/记录位置：不适用（本阶段无 UI 改动）；GUI 存活性经 http://127.0.0.1:3080 → 200 验证
功能矩阵对应项：docs/unified-feature-matrix.md 全部
内存/进程/故障验证：docs/p0-baseline.md §4（旧方案 RSS 实测）
本次已勾选项：P0.1、P0.2、P0.3、P0.6
未完成项及原因：P0.4（子代理契约文档撰写中）、P0.5（storage schema 待 P0.4 输入）、P0 验收（待前两者）
## P1 阶段证据（2026-09-05）

阶段 / 叶子任务 ID：P1.1-P1.7 + P1 验收
修改文件：见第 11 节改动文件清单
执行命令与退出码：tsc --noEmit(0)、npm run build(0)、npm test(0)、npm run test:engine(0)、node scripts/pack-check.mjs(0)
自动测试结果：宿主 57/57；引擎 807 pass / 2 skip（54 文件）；pack-check e2e：pack → 隔离安装(73 包,--omit=dev) → supervisor spawn → ready(pid/httpPort) → engine.bearer → MCP initialize + tools/list + echo(msg) 往返 → dispose 无账本残留
功能矩阵对应项：全部（引擎迁移是矩阵所有行的载体）
内存/进程/故障验证：orphan-reap 真实进程测试（死属主杀/活属主留/死 pid 落账本清理）；引擎临时端口与运行中 19999 网关共存实证
本次已勾选项：P1 全部（P1.1-P1.7+验收）
未完成项及原因：GUI 实机停用/重启验证（P8）；IPC 域方法集（P2-P4 随阶段扩充）；旧 embed 通路收编决定（P6）
## P2 阶段证据（2026-09-05）

阶段 / 叶子任务 ID：P2.1-P2.7 + P2 验收
修改文件：src/config/{types,standard-repo,native-catalog,session-store,merge,service,transfer}.ts（新增）、src/index.ts（发现层 dedup 修复）、test/config-service.test.mjs（新增 12 测试）、test/plan.test.mjs（+1 回归）
执行命令与退出码：tsc --noEmit(0)、npm run build(0)、npm test(0)、npm run test:engine(0)
自动测试结果：宿主 70/70（含 config-service 12 项：往返保留未知字段/冲突拒绝/非法 JSON 不覆盖/secret 三态/层序与 .agents 后者胜/tombstone 三场景/同层冲突/项目隔离/密封信封/symlink/缺失目录/导入转换）；引擎 807 pass/2 skip
功能矩阵对应项：管理 API 的配置面（PUT /api/mcps/:name、order/groups、managed override 语义）由本层取代
本次已勾选项：P2 全部
未完成项及原因：storage 根目录 0700 收紧与 DSH workspace resolver 实接在 P3/P5；旧 gateway 数据显式迁移在 P6；外部客户端导出（引擎端点）在 P6
## P3 阶段证据（2026-09-05，进行中）

阶段 / 叶子任务 ID：P3.1、P3.2、P3.3、P3.5、P3.6（本轮勾选）；P3.4 部分（快照 e2e 已测，fork/恢复留实机）
修改文件：src/engine/ipc-service.ts（mcp.ensure/remove/tools/call/status 域方法+启动失败语义+竞速取消/超时）、src/agent.ts（preset 行入口：双屏障+标准转换+逐条目隔离+快照）、src/runtime/engine-shared.ts、src/config/service.ts（maskSecrets 可信边界）、src/config/session-store.ts（snapshot 字段往返）、src/index.ts（发布引擎单例）、test/agent-entry.test.mjs（e2e）、test/config-service.test.mjs（+2）
执行命令与退出码：tsc(0)、build(0)、npm test(0)
自动测试结果：宿主 71/71（agent-entry：屏障注册→引擎调用往返→快照→scope 清零）；引擎 807/807
关键修复：掩码 sentinel 曾被送进引擎 HTTP 头（ByteString 8226）→ preview 增 maskSecrets:false 宿主可信通道；mcp.ensure 启动失败改为 lifecycle:error 应答而非抛异常（单坏服务不再中止全会话）
本次已勾选项：P3.1/3.2/3.3/3.5/3.6
未完成项及原因：P3.4 fork/恢复需 DSH 实机（P8 前置）；P3.7 resources/prompts IPC 与 P3.8 取消桥/内容上限待下轮；P3.9/3.10 依赖 P5 管理面
## P3.7/3.8 + P4 阶段证据（2026-09-05）

阶段 / 叶子任务 ID：P3.7、P3.8（勾选）；P3.9/3.10（部分，注释说明）；P4.1-P4.9（勾选，验收留 P8）
修改文件：src/engine/ipc-service.ts（+mcp.resources/resourceRead/prompts/setToolEnabled/setResourcesEnabled/start/stop/restart + engine.memory[真实子树 PID] + mcp.call source 归因 + tunnels.* 16 方法[CRUD/test/trust/start/stop/port/groups/order，掩码往返+Dependents 语义+行状态失败应答]）、src/engine/engine-main.ts（Engine 暴露 tunnelStore）、src/runtime/engine-supervisor.ts（request 支持 signal→cancel 帧）、src/agent.ts（exec.signal 桥接+512KB 内容预算）、test/engine-domains.test.mjs（2 e2e）
执行命令与退出码：tsc(0)、build(0)、npm test(0)、npm run test:engine(0)
自动测试结果：宿主 73/73；引擎 807/807
关键语义：工具开关仅静态工具集适配器支持[mysql 测试]而 echo/proc 如实答错；隧道列表 DTO 完全不含秘密；tunnels.upsertConnection 掩码 sentinel 往返保密码
本次已勾选项：P3.7、P3.8、P4.1-P4.9
未完成项及原因：P3.4 fork/恢复与 P4 验收需 DSH 实机/真实 SSH server（P8 前置）；P3.9 Data/calls/traffic 与 P3.10 影响预览的宿主 RPC 随 P5 UI
## P5 阶段证据（2026-09-05，进行中）

阶段 / 叶子任务 ID：P5.1、P5.5、P5.8（勾选）；P5.2/5.3/5.4（部分，注释）；P5.6/5.7/5.9/5.10 待做
修改文件：src/host/api.ts（同源桥：信任围栏[Host/Origin/Sec-Fetch-Site/对端环回]+preview/entry/enabled/engine/memory/mcp 域/tunnels 域路由）、src/index.ts（webServer 注入+桥挂载）、src/client/ 全新七模块（esbuild bundle）、package.json（build:client）、test/host-bridge.test.mjs（2 测试：围栏四拒一放+真实服务往返+409 冲突+engine off）
执行命令与退出码：tsc(0)、build(0)（含 esbuild）、npm test(0)、pack-check(0)
自动测试结果：宿主 75/75；客户端 bundle 33.7KB 含 loader/section/conversation 注册[字节级断言]
本次已勾选项：P5.1、P5.5、P5.8
未完成项及原因：P5.6 高级页（env/token/备份恢复）与 P5.7 项目菜单上游扩展待下轮；P5.9 dirty 提示/长操作取消、P5.10 系统性主题/键盘/窄屏检查待 UI 收尾轮
## P6.9 + P7 + P8.1 阶段证据（2026-09-05）

阶段 / 叶子任务 ID：P6.9（勾选）、P7.1-7.6+7.10+验收（勾选）、P7.7/7.8/7.9（注明待实机/CI）、P8.1（勾选）
修改文件：src/host/api.ts（+skill/install、+creds 路由）、src/client/pages/advanced.ts（两按钮）、docs/test-matrix.md（P7 全矩阵映射）、README.md（P8.1 全新）、TASK.md
自动测试结果：宿主 77/77、引擎 807/807、pack-check 退出 0（全部在本轮重跑确认）
未完成项及原因：P7.7/7.8/7.9 与 P8.2-8.9 的实机部分依赖授权重启 dsh web（用户提问已发出超时未答；下一轮继续跟进或按用户 chat 指示执行）
## P8.2 + P8.3 阶段证据（2026-09-05）

阶段 / 叶子任务 ID：P8.2、P8.3（勾选）
修改文件：docs/unified-feature-matrix.md（迁移终态表）、TASK.md
验证：工件静态核验脚本输出（profile 链接 → dist 全组件在位/38.4KB client/engines>=22.19.0）；引擎套件 807/807 本轮未变动无需重跑
未完成项及原因：P8.4-8.9 全部依赖授权重启 dsh web（用户两轮未应答提问；继续保留）
## P5.6 + P6 阶段证据（2026-09-05）

阶段 / 叶子任务 ID：P5.6、P6.1-P6.8（勾选）；P6.9 部分、P6 验收部分（注释）
修改文件：src/config/legacy-read.ts（只读旧格式：密封/明文/异机三态，绝不触发自动密封）、src/config/legacy-import.ts（plan/apply：逐类映射+override 折叠+幂等+逐文件原子+新家目录重密封）、src/host/api.ts（+token/default、migration/plan、migration/apply 路由）、src/client/pages/advanced.ts（高级页三卡）、test/legacy-migration.test.mjs（2 测试）
执行命令与退出码：tsc(0)、build(0)、npm test(0)、npm run test:engine(0)、真实数据 dry-run node dbg(0 后清理)
自动测试结果：宿主 77/77；引擎 807/807；客户端 bundle 37KB 含高级页
真实数据证据：本机运行中网关的状态目录只读预检——19 行：11 个 MCP + 1 条 tunnel + env + token；0 不可解密、0 警告、源目录零写入
本次已勾选项：P5.6、P6.1、P6.2、P6.3、P6.4、P6.5、P6.6、P6.7、P6.8
未完成项及原因：P6.9 skill install/creds 等效按钮（UI 打磨轮）；P6 验收的导入后重启验证与回滚演练需宿主实机（P8 前置）
## P5.7 + P5.9/5.10 阶段证据（2026-09-05）

阶段 / 叶子任务 ID：P5.7（勾选）；P5.9、P5.10（部分，注释）
修改文件：deepseek-harness 4 文件通用槽[git status：slots.ts/index.ts/Rows.tsx/WorkspaceBrowser.tsx]、本插件 src/client/{index,ui}.ts（菜单项注册+aria）、docs/workspace-menu-extension.md（可复现构建/部署）
自动测试结果：宿主 77/77、bundle 37.4KB；上游变更为通用槽不含 MCP 业务（DSH 契约）
未完成项及原因：上游部署+实机点击验证需授权重启（P8）；长操作取消按钮与键盘走查随 GUI 实机

```text
阶段 / 叶子任务 ID：
修改文件：
执行命令与退出码：
自动测试结果：
UI 实际操作、URL、截图/记录位置：
功能矩阵对应项：
内存/进程/故障验证（适用时）：
本次已勾选项：
未完成项及原因：
```

### 2026-09-10 DSH 0.1.5-alpha.2 适配（维护轮，非 TASK 阶段）

日期与执行者：2026-09-10，Claude（主线会话）
变更内容与原因：dsh 全局安装更新至 0.1.5-alpha.2（0:17），实测注入全链路存活；两处契约漂移修复——agent/pre-step 载荷（sessionId 字段移除，agent.id 为主读）与 assemble-先于-waterfall（请求 #1 工具目录屏障失效）→ prewarm 门闩 + def-hash 热缓存 + supervisor epoch；docs/dsh-integration-contract.md 重写为 0.1.5-alpha.2 实测版
执行命令与退出码：npm run typecheck（0）、npm run build（0）、npm test（167/167，0）；test:engine 未跑（src/engine 零改动）
自动测试结果：session-runtime 新增 6 用例全绿（warm-cache 零往返 / epoch 失效 / 租约释放失效 / prewarm 三态）；fake 引擎补 def-twin 匹配（对齐 engine ipc-service.ts:113-114）
UI 实际操作、URL、截图/记录位置：live 验证 curl 3080 /dsh-mcp-manager/{engine,workspaces}；会话证据 ~/.dsh/sessions/--C-PythonProject-dev-rustdesk--/session-ebb4c58f（system SDK 含 12 处 mcp__）
功能矩阵对应项：docs/unified-feature-matrix.md 会话工具注入项（不变）
内存/进程/故障验证：Win32_Process 实测 dsh PID 52120（17:05 起）+ 引擎子进程 PID 58452；prewarm start:false 不新增常驻进程
本次已勾选项：无 TASK 勾选变化（维护轮）
未完成项及原因：dsh web 未重启（用户动作）——重启后 prewarm 日志行与子代理首请求工具面待实测；冷 def 首机器会话竞态记录于契约 §12.1
