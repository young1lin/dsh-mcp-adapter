# P7 自动化与故障测试矩阵（随阶段执行汇总）

> 每行映射 TASK P7.1-P7.10 到实际套件/测试名。运行方式：`npm test`（宿主面，77 项）+ `npm run test:engine`（引擎面，807 项）+ `node scripts/pack-check.mjs`（工件 e2e）。

| 矩阵项 | 覆盖 | 证据（套件 → 测试） |
| --- | --- | --- |
| P7.1 配置优先级/disabled/同名冲突/unknown fields/原子写/revision/secret 三态/schema 迁移 | ✅ | test/config-service.test.mjs（12）：层序与 .agents 后者胜、tombstone 三场景、同层冲突排除、项目隔离、未知字段/兄弟保留、revision 冲突拒绝、非法 JSON 不覆盖、sentinel 往返、密封信封、symlink、缺失目录、导入转换；test/plan.test.mjs（disabled→skipped 回归） |
| P7.2 会话 A/B 项目同名不同凭据/覆盖/继承/禁用/旧新 revision/首轮等待 | ✅（实机 fork 留 P8） | config-service（wsA/wsB 同名独立解析、会话 pending）；agent-entry（agent/created+pre-step 双屏障、快照、scope 清零、单服务失败隔离） |
| P7.3 协议：stdio 参数边界/HTTP/SSE 行为/tools 分页/资源提示词/取消超时/断线不重复写 | ✅ | 引擎面：proc/http-adapter/rest-*/paging/resources/tool-server/proxy-*（807 内含）；宿主面：engine-ipc（超时 E_TIMEOUT/未知方法）、agent 512KB 预算+竞速取消；SSE=引擎仅 streamable-http 且明确不支持（不假装） |
| P7.4 引擎：启动失败/崩溃重启退避/父死/停用/多宿主/已存在服务/端口占用/引用计数/空闲回收 | ✅ | engine-ipc（spawn→握手→ping→status→优雅 dispose 无账本残留；disposed→E_DIED）；engine-orphan（死属主杀/活属主留/pid 复用三重校验）；引擎面 lazy-proc/proc-pids/pidfile/daemon；退避重启=监督器 BACKOFF 表+60s 稳定重置（代码路径，实机崩溃注入留 P8） |
| P7.5 隧道：指纹变更/认证失败/断开/端口冲突/关闭监听/socket 清理/重连池失效/限流 | ✅（注入式 fake ssh2） | 引擎面 tunnel-ssh/tunnel-manager/tunnel-forward/tunnel-port/tunnel-api/tunnel-store/tunnel-import/tunnel-mcpmatch（含字节级中途停止断言、auth 不重连）；真实 SSH server 演示留 P8 |
| P7.6 安全：路径越界/symlink/陌生命令/管理权限/CSRF-Origin/loopback/token/secret 脱敏与明确导出 | ✅ | host-bridge（围栏：rebinding Host/非环回对端/跨 Origin/跨 site 四拒一放）；config-service（symlink 拒编、越界=宿主解析无路径透传）；engine-domains（列表 DTO 零秘密+掩码往返）；token 揭示=显式动作 |
| P7.7 UI：三入口/CRUD/冲突/来源范围/Run/Tunnel/日志/备份/主题语言 | ◐（代码面完成，实机待 P8） | settings.section mcp-connections + conversation.view（sessionId）+ workspace.menu.action（上游）；zh/en 字典；--dsw-alias 主题变量；状态面（loadFailed/retry/409/empty/busy/dirty）；键盘窄屏实机走查待 P8 |
| P7.8 性能：进程树对比/多会话共享/空闲回收/上限/无隐藏探测 | ◐（基线+机制，对比报告待实机） | p0-baseline §4（旧方案 RSS 实测）；引擎懒启动 600s 回收+页缓存 TTL+ring 上限+MAX_FILL_PAGES；http/rest 无周期探测（源码契约） |
| P7.9 平台 | ◐ | Windows 全套实测（本机）；Linux 路径在引擎源码内置（machine-id/secret-tool 分支），CI 矩阵随仓库 CI（.github/workflows/ci.yml 已有，node 矩阵补 22.19+ 待仓库级维护） |
| P7.10 发布工件 | ✅ | scripts/pack-check.mjs：npm pack → 隔离目录 --omit=dev 安装 → 引擎 spawn → bearer → MCP initialize + echo 往返 → 优雅 dispose（退出 0，持续绿） |

**统计**：宿主 77 项（config 12+1、IPC 4、orphan 1、agent 1、bridge 2、migration 2、旧 52+host 补丁）；引擎 807 项；工件 e2e 1；真实数据 dry-run 1（19 行）。
