# 统一功能对照矩阵（unified-feature-matrix）

> 来源：<gateway-repo> @ 45884f1（2026-09-05 逐文件实测盘点，非 README 推测）。
> 目标：迁移进 dsh-mcp-adapter 单插件（UI 统一叫「MCP 与连接」）。目标模块列给出设想位置（src/engine|host|client 下），实施时可按 P0.5 冻结的目录调整，但每行都必须有归宿，不允许丢弃。
> 鉴权说明：全部 /api 路由依赖 router 的 loopback 三重守卫（peer 地址 + Host + Origin，src/local-only.ts）；MCP 端点（POST /<name>）另有 bearer token。迁入 DSH 后管理权改由宿主管理服务代理，loopback 边界保留给"供其他客户端使用"的对外端点。

## 1. 概览

| 项 | 值 |
| --- | --- |
| 版本/入口 | local-mcp-gateway 0.1.0，bin=lmg→dist/bin.js；服务端 dist/index.ts |
| 默认端口 | 19999（loopback only，拒绝 0.0.0.0，src/config.ts） |
| 依赖 | MCP SDK v2(@modelcontextprotocol/client|server|node)、mysql2、ioredis、mongodb、pg、ssh2、undici、zod v4、dotenv；node>=22.19.0 |
| 状态文件 | 数据目录 %APPDATA%/local-mcp-gateway（datadir.ts），全部 AES-256-GCM 信封加密（secure/） |
| UI | src/admin/ 原生 ES modules 单页（index.html+js/+styles/），无构建步骤，随服务分发 |

## 2. 管理 HTTP API 清单（adminapi.ts + tunnels/api.ts + dbbrowser-api.ts + router.ts）

### 2.1 MCP 管理（src/adminapi.ts）

| 方法+路径 | 作用 | 目标模块 | 回归用例 |
| --- | --- | --- | --- |
| GET /health | 存活探测 {ok:true} | host 健康检查 | embed.ts 探活已覆盖 |
| GET /health/check | 触发全量健康检查 | engine→host 状态 | test/router.test.ts |
| GET /api/info | tokenEnv 名 + 面板版本戳 | host 元信息 | 面板自更新逻辑移除后不需要 |
| GET /api/mcps | 全部 MCP 状态轻列表（含 tag/description/group/latency/state/reason/order） | host 列表 DTO | test/adminapi.test.ts |
| POST /api/mcps | 新增 MCP（buildDef 校验各类型字段；enabled 默认 true） | host 创建服务 | 同上 |
| PUT /api/mcps/:name | 编辑定义并按需重启（掩码往返恢复秘密；config 源写 override 保 ${ENV} 引用；停用不复活） | host 编辑 | test/adminapi + managed.test.ts |
| DELETE /api/mcps/:name | 删除（config 源同时 removeConfigServer；tunnel 链接 forgetMcp） | host 删除 | 同上 |
| POST /api/mcps/:name/rename | 重命名（registry+store+tunnels+calls 别名联动） | host 重命名 | test/registry.test.ts |
| POST /api/mcps/:name/start|stop|restart | 生命周期（store.setEnabled 同步） | host 生命周期 | 同上 |
| POST /api/mcps/test | 真连接测试（DB ping / http initialize / rest GET；5s 上限；不落盘） | host 连接测试 | test/mcp-test.test.ts |
| POST /api/mcps/import | 导入客户端 .mcp.json（stdio→proc、url→http；重名 -1/-2；自指 URL 跳过） | host 导入 | test/mcp-import.test.ts |
| GET /api/mcps/:name/details | 详情：状态/原因/掩码配置/proc stderr/关联 tunnels | host 详情 DTO | test/adminapi.test.ts |
| GET /api/mcps/:name/calls（分页）/calls/:seq/clear | 调用日志（磁盘 JSONL 持久、脱敏、分页、单条全量） | engine 观测 | test/calls*.test.ts |
| GET /api/mcps/:name/tool-history?tool=&q=&limit= | 单工具最近运行（Run 面板回填，300 上限） | engine 观测 | 同上 |
| GET /api/mcps/:name/:kind（tools/resources/prompts，cursor 分页） | 浏览三类原语（服务端增量页缓存 60s TTL、disabled 工具/资源开关状态附带） | engine 分页 | test/paging.test.ts、resources.test.ts |
| POST /api/mcps/:name/call | 面板手动调用工具（withCallSource("panel") 标注来源；503 未启动） | host Run | test/admin-panel.test.ts |
| POST /api/mcps/:name/resource | 面板读资源（同上标注） | host 资源浏览 | 同上 |
| POST /api/mcps/:name/tools/:tool | 单工具启用/禁用（live Set + 持久 + list_changed 通知） | engine 开关 | test/tool-server.test.ts |
| POST /api/mcps/:name/resources-toggle | 资源总开关（live + 持久 + 通知） | engine 开关 | 同上 |
| PUT /api/order | 侧栏排序（managed.order） | host 排序 | test/adminapi.test.ts |
| PUT /api/groups、POST /api/groups/:name/rename、PUT /api/mcps/:name/group | 自定义分组 CRUD/改名/归组（default 保留组） | host 分组 | 同上 |
| GET /api/memory?tree=1 | 内存信息（进程树可选） | engine 诊断 | test/mem.test.ts |
| POST /api/shutdown | 优雅停机（res finish 后 emit SIGTERM） | engine 生命周期 | test/shutdown-api.test.ts |
| GET /api/traffic（过滤分页）/traffic/:seq / DELETE | 交互流量环（token+client 归因、8KB 上限、JSONL 尾巴恢复） | engine 观测 | test/traffic.test.ts |
| GET/POST /api/tokens、GET /api/tokens/:id/secret、DELETE、POST /:id/rotate | 命名 token CRUD/轮换/取密 | host 高级页 | test/token-pick.test.ts、adminapi |

### 2.2 隧道（src/tunnels/api.ts）

| 方法+路径 | 作用 | 目标模块 | 回归用例 |
| --- | --- | --- | --- |
| GET /api/tunnels | 连接+规则+组+MCP 名单一次读 | host SSH 页 | test/tunnel-api.test.ts |
| PUT /api/tunnels/order、PUT/POST groups/:kind[/rename|/:id] | 两类列表排序/分组 | host SSH 页 | 同上 |
| GET /api/tunnels/keys、GET /api/tunnels/browse?dir= | ~/.ssh 密钥清单 + 任意目录浏览（私钥选择器） | host SSH 页 | 同上 |
| GET /api/tunnels/suggest/:port | 按 loopback 端口猜关联 MCP（mysql/redis/pg 值匹配） | host 关联 | test/tunnel-mcpmatch.test.ts |
| POST/PUT/DELETE /api/tunnels/connections[/:id] | SSH 连接 CRUD（掩码往返；hostKey 保留规则） | host SSH 页 | test/tunnel-store.test.ts |
| POST /api/tunnels/connections/:id/test | 一次性客户端实测（banner/kind/fingerprint） | host 测试 | test/tunnel-ssh.test.ts |
| POST /api/tunnels/connections/:id/trust | TOFU 指纹确认/重置 | host 指纹确认 | 同上 |
| POST/PUT/DELETE /api/tunnels/rules[/:id] | 规则 CRUD（?start、DependentsError 409+confirmRequired） | host 映射页 | test/tunnel-api.test.ts |
| POST /api/tunnels/rules/:id/start|stop | 启停（失败返回行状态+portOwner；force） | host 映射页 | test/tunnel-manager.test.ts |
| POST /api/tunnels/start-all|stop-all | 批量（按连接分组串行） | host 批量 | 同上 |
| GET /api/tunnels/port/:port、POST /:port/free | 端口占用诊断与显式强杀（拒绝杀自己） | host 冲突诊断 | test/tunnel-port.test.ts |

### 2.3 数据浏览（src/dbbrowser-api.ts，mysql/pg/mongo/redis）

| 方法+路径 | 作用 | 回归用例 |
| --- | --- | --- |
| GET /api/db | 可浏览 MCP 列表 | test/dbbrowser*.test.ts |
| GET /api/db/:name/tables、/schema、/data | 表清单/结构/数据网格（过滤、分页） | 同上 |
| GET /api/db/:name/export、POST /import | CSV 导出/导入 | 同上 |
| POST /api/db/:name/query、/ddl、/edits | SQL 控制台 / DDL / 行编辑提交（事务性） | 同上 |
| GET /api/db/:name/collections、/docs | mongo 集合/文档网格 | 同上 |
| GET /api/db/:name/keys、/key、POST /command | redis SCAN 键窗/键值/受限命令 | 同上 |

## 3. CLI 命令（src/cli.ts，bin=lmg）

| 命令 | 作用 | 新入口 | 回归用例 |
| --- | --- | --- | --- |
| lmg start（-f 前台/--no-open/-p） | 守护化启动（V8 flags、pidfile、健康轮询、竞态双启动判定） | 插件引擎自管；CLI 保留为可选兼容入口 | test/daemon.test.ts、cli.test.ts |
| lmg stop（--force）/restart | 优雅停机→树杀兜底；PID 复核拒绝误杀 | 插件 dispose | 同上 |
| lmg status（--json，退出码 3=未运行） | 运行态+MCP 健康+内存 | DSH 诊断页 | 同上 |
| lmg logs（-f/-n） | 后台日志尾随（轮转感知） | 插件日志 | cli.test.ts |
| lmg token / creds | 读取/打印令牌与面板 URL | DSH 高级页 | 同上 |
| lmg open | 打开面板浏览器 | 不需要（DSH 内嵌 UI） | — |
| lmg export / import | 全状态明文导出/再密封导入（恢复/迁移通道，保留） | DSH 高级页备份恢复 | test/secure-store.test.ts |
| lmg skill install | 安装 AI skill 到 ~/.agents|~/.claude|~/.cursor | DSH skill 体系内等效 | test/skill-install.test.ts |

## 4. 适配器类型（src/adapters/）

| 类型 | 源文件 | 工具 | 特性 | 目标模块 |
| --- | --- | --- | --- | --- |
| mysql | mysql.ts(591L)+mysql-resources.ts | mysql_query、mysql_list_tables | readonly 会话、maxRows、Data 浏览（CSV/行编辑/DDL）、表资源分页、ping | engine/adapters |
| pg | pg.ts(529L)+pg-resources.ts | pg_query、pg_list_tables、pg_describe_table | 同上（url 连接串、${ENV}） | engine/adapters |
| mongo | mongo.ts(452L)+mongo-resources.ts | find/aggregate/list_collections/describe_collection/insert_many/update_many/delete_many | readonly 可禁写、BSON 归一化、schema 采样资源、文档网格 | engine/adapters |
| redis | redis.ts(628L)+redis-resources.ts | redis_scan、redis_read、redis_command | readonly、危险命令黑名单、allowEval、SCAN 键窗资源 | engine/adapters |
| proc | proc.ts(233L)+proxy.ts | 代理子进程全部 | 懒启动默认、空闲回收、stderr 环形缓冲 64KB、树杀、握手 60s/调用 180s 超时、GBK 解码、exposeResources/Prompts | engine/adapters |
| http | http.ts(91L)+proxy.ts | 代理远端 | streamable-http only（SSE 不支持）、协商能力透传、无 ping（防计费探测）、proxy 代理 | engine/adapters |
| rest | rest.ts(128L)+rest-template.ts(122L) | 按声明生成 | tools 数组声明式 REST→MCP、模板渲染、超时、代理 | engine/adapters |
| echo | echo.ts | echo | 自测 | engine/adapters |
| 第三方 | factory.ts ExternalAdapter | 任意 | def.adapter 指定模块（包名/./相对 dataDir/绝对路径），createAdapter(def,name) 契约，可选能力全委托 | engine/adapters（需授权加载） |
| 公共 | tool-server.ts | — | 输出预算（1000 项/256KB、UTF-8 安全截断、降载提示）、instructions 构建、资源挂载、脱敏调用日志 | engine/adapters 公共 |
| 公共 | sql.ts | — | 只读 SQL 判定、表分页参数 | 同上 |

## 5. 隧道/SSH 能力（src/tunnels/）

| 能力 | 源文件 | 要点 | 目标模块 |
| --- | --- | --- | --- |
| 连接存储 | store.ts(384L) | tunnels.json 密封、校验、hostKey 保留/清除、组/排序、renameMcp/forgetMcp | engine/tunnels |
| 规则运行时 | manager.ts(644L) | 引用计数共享 SSH 客户端、per-rule 串行队列、断线路径先拆端口、重连指数退避±20% 抖动 5min 上限、auth/hostkey/port/config 不重试、DependentsError 影响预览、stalePool 通知 | engine/tunnels |
| SSH 客户端 | ssh.ts(289L) | ssh2 懒加载、TOFU hostVerifier、keepalive 15s×3、${ENV} 凭据连接期展开、banner、分类错误 | engine/tunnels |
| 本地转发 | forward.ts(180L) | 端口仅在有承载时绑定、close 销毁全部已接受 socket 并 waitForRelease、200 socket 上限、字节统计 | engine/tunnels |
| 端口诊断 | port.ts(114L) | netstat/tasklist 轻量探测、probePort 真绑定测试、forceFree 拒绝杀自己 | engine/tunnels |
| 旧工具导入 | import.ts(95L) | forward-port config.json 一次性导入（全部停用状态） | P6 迁移 |
| MCP 关联 | mcpmatch.ts | loopback host:port 值匹配建议；只读视图 | engine/tunnels |

## 6. 安全与存储（src/secure/ + token/mask/privfs/local-only）

| 能力 | 源文件 | 要点 | 目标模块 |
| --- | --- | --- | --- |
| 主密钥 | secure/key.ts(234L) | DPAPI/Keychain/libsecret/机器ID 四级来源+env 覆盖（CI/恢复），缓存 | engine/security |
| 密封信封 | secure/envelope.ts(78L) | {lmg:1,alg,keySource,salt,iv,tag,ct} AES-256-GCM+HKDF 每文件盐 | engine/security（P6 只读兼容） |
| 状态文件 | secure/statefile.ts(62L) | 读兼容明文并立即密封（P6 需绕开副作用！）、写总是信封+原子 | engine/security |
| 环境存储 | secure/envstore.ts(107L) | .env 迁移 verify-then-delete、注入 process.env 不覆盖 | engine/security |
| token 管理 | token.ts(128L) | 命名 token、timingSafeEqual、种子迁移 default、轮换/吊销 | engine/security |
| 脱敏 | mask.ts(154L) | KEY/ENV/HEADER/URL/命令行五类掩码+sentinel 往返+dropSentinel；调用/流量日志共享词表 SECRET_ARG_KEY_RE | engine/security |
| 本机边界 | local-only.ts(91L) | peer+Host+Origin 三重 loopback、无退出开关 | host 安全层 |
| 私有权限 | privfs.ts | 0700/0600 | engine/security |

## 7. 观测（calls/traffic/mem/进程）

| 能力 | 源文件 | 要点 | 目标模块 |
| --- | --- | --- | --- |
| 调用日志 | calls.ts(682L) | JSONL per-MCP、AsyncLocalStorage 归因（client/source）、分页 20、TOOL_HISTORY_MAX=300、保留清扫、rename 别名、脱敏 | engine/observability |
| 流量环 | traffic.ts(520L) | 内存环+磁盘尾巴、请求/响应 8/16KB 截断、client 聚合、按 client 清除 | engine/observability |
| 内存 | mem.ts(131L) | 进程内+子树（缓存失效） | engine/observability |
| 进程树 | process-tree.ts(137L) | treeKill（taskkill /T）、后代集合、他实例检测、孤儿 MCP 清扫 | engine 生命周期 |
| PID 账本 | proc-pids.ts(96L)+pidfile.ts(114L) | 端口隔离 .proc-pids-<port>.json、gateway-<port>.pid、守护端口枚举 | engine 生命周期 |
| 日志 | log.ts | JSON 行 stdout | engine 基础 |

## 8. UI 视图（src/admin/js/，28 个模块）

| 视图 | 源文件 | 功能 | 目标页面（DSH client） |
| --- | --- | --- | --- |
| 侧栏 | sidebar.js+menu.js | 分组/折叠/拖拽排序/弹出菜单/状态点 | MCP 服务列表 |
| 详情 | detail.js+pane.js | 概览/配置/操作（启停重命名删除）/连接命令复制 | MCP 详情 |
| 添加/编辑 | add-sheet.js+fields.js | 类型化表单（字段 schema、连接测试按钮）、导入 | 创建向导 |
| Run | run.js+run-history.js | 参数表单、历史回填搜索、结果展示、日志页 | 详情 Run |
| Logs | logs.js | 调用日志分页/展开全量/stderr | 详情日志 |
| Traffic | traffic.js | 按 MCP/客户端/方法过滤、环浏览 | 日志与诊断 |
| Tokens | tokens.js+connect.js | token CRUD、连接片段（Claude/Cursor/JSON）复制 | 高级设置 |
| Tunnels | tunnels.js+tunnel-sheets.js | 连接/规则双列表、分组排序、启停、指纹确认、端口冲突强杀、统计 | SSH/Tunnel 页 |
| Data | data-browsers/view/grid/cell/edit/csv/filters/sql/structure（9 模块） | mysql/pg 表网格行编辑 CSV、mongo 文档、redis 键值、SQL 控制台高亮 | 详情 Data |
| 基础 | util/dropdown/polling/main | apiJson/esc/toast/主题、自定义下拉、6s 轮询、渲染契约 | client/components |

## 9. 导入与兼容

| 能力 | 源文件 | 要点 | 目标 |
| --- | --- | --- | --- |
| .mcp.json 导入 | mcp-import.ts | mcpServers/servers/裸映射三种形态、重名后缀、自指跳过 | P2/P6 导入预览 |
| skill 安装 | skill-install.ts | 三目录 stage+swap 原子安装 | P6 等效入口 |
| forward-port 导入 | tunnels/import.ts | 首次运行一次性 | P6 |
| managed override | managed.ts+index.ts | config 源编辑写 override、mcpEnabled 停用记忆、disabledTools/resourceToggles 持久 | P2 合并模型 |
| bootstrap | bootstrap.ts | 首次运行 seed（echo+token）、repo .env/config 一次性收编密封 | P6 迁移预检 |

## 10. 未映射/需新设计项

1. 面板自更新（panelVersion 轮询）— DSH client bundle 机制替代，无需迁移。
2. lmg open（浏览器打开）— 不适用。
3. express→自研 Router — 引擎内部保留；对外管理 API 不直接暴露给浏览器（宿主代理）。
4. /api/info 的 tokenEnv 暴露 — 由 DSH 高级页等效展示。
5. 端口固定 19999 语义 — 引擎私有 IPC 替代；19999 仅在"外部客户端模式"显式开启。


## 迁移终态（P8.2，2026-09-05）

> 状态：✔=已实现且自动测试验证；◐=已实现、实机验证待 P8 授权重启。

| 域 | 原入口 | 新入口 | 状态 |
| --- | --- | --- | --- |
| MCP CRUD/启停/重命名/分组/排序 | 面板 /api/mcps* | Settings→MCP 与连接 + /dsh-mcp-manager 桥 + 三级作用域 | ✔（config-service 13 + bridge 2） |
| 工具/资源/提示词浏览与开关 | 面板 detail/paging | 详情页五标签 + mcp.tools/resources/prompts/setToolEnabled IPC | ✔（engine-domains） |
| Run/Data/日志/流量/内存 | 面板 run/logs/traffic/memory | Run 标签[panel 来源] + engine.memory + mcp.status | ✔ 数据面；Data 网格 ◐（UI 打磨随实机） |
| SSH/规则/指纹/端口诊断 | /api/tunnels* | SSH 页 + tunnels.* 16 IPC | ✔（engine-domains + 引擎套件） |
| Token/env/加密恢复/外部客户端 | /api/tokens + lmg export/import | 高级页 token/creds/skill install + 迁移 plan/apply | ✔（migration 2 + 真实数据 dry-run） |
| .mcp.json 导入 | POST /api/mcps/import | transfer.planStandardImport/planNativeImport 预览式导入 | ✔ |
| 旧 forward-port 导入 | 首跑自动 | engine-main 显式开关 | ✔（引擎套件） |
| CLI 11 命令 | lmg | DSH 等效（高级页/诊断/迁移）；独立 lmg 保留恢复通道 | ✔（P6.9） |
| 面板自更新/浏览器打开 | panelVersion/lmg open | DSH client bundle 机制替代 | 不迁移（by design） |
| 会话工具挂载 | 旧 agent/created 竞态 | preset 行 + agent/pre-step await 屏障 | ✔（agent-entry e2e；实机首轮 ◐） |
| 项目菜单入口 | 无 | 上游 workspace.menu.action 通用槽（4 文件已改） | ◐（部署随授权） |

## 统计

- 管理 API 路由：MCP 域 31 + 隧道域 19 + 数据浏览 14 + 顶层 3（/、/health、/health/check）≈ 67
- CLI 命令：11（start/stop/restart/status/logs/token/creds/open/export/import/skill）
- UI 视图模块：28 个 JS 模块（约 10 个功能视图域）
- 适配器：8 内置类型 + 第三方 ExternalAdapter + 公共 tool-server/sql/resources
- 测试文件：54 个 .test.ts + setup.ts（vitest），迁移时作为回归基线逐域搬移
