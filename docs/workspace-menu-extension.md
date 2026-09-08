# 通用 Workspace 菜单扩展（workspace.menu.action）

## 变更位置（上游 DSH 源码 <dsh-source> @ master）

通用扩展槽 `workspace.menu.action`（list/root），任何插件可注册行级菜单项；DSH 自身不含任何 MCP 业务：

1. `packages/client/ui-workspace/src/client/contract/slots.ts`
   - SlotMap 声明 `'workspace.menu.action': { kind: 'list'; scope: 'root' }`
   - `WorkspaceBrowserInjected` 增加可选 `workspaceMenuActions(workspaceId)`
2. `packages/client/ui-workspace/src/client/index.ts`
   - `sidebar.workspaces` 注册的 children 声明该槽
   - `browserInjected()` 从 `ctx.slots.entries('workspace.menu.action')` 组装（label + inject(workspaceId).onSelect）
3. `packages/client/ui-workspace/src/client/rows/WorkspaceBrowser.tsx`
   - `SessionTreeProps` 增加可选 `workspaceMenuActions`；外层组件解构并传入 SessionTree，再传给 `ProjectRowItem` 的 `menuExtras`
4. `packages/client/ui-workspace/src/client/rows/Rows.tsx`
   - `ProjectRowItem` 接受 `menuExtras`，追加在 rename/delete 之后；未知 id 经 extras.onSelect 分发

## 消费方（本插件）

`src/client/index.ts` 注册 id=mcp-connections 的菜单项，onSelect 打开设置工作台（宿主无 settings.open 时静默跳过）。宿主未部署本扩展时该注册无害（槽不存在则条目不可见，无错误）。

## 可复现构建与部署（P8.3；需用户授权执行）

```powershell
cd <dsh-source>
pnpm install
pnpm --filter @deepseek-ai/dsh-web-app build     # 产出 web 客户端 bundle
# 将产物按当前安装布局部署到
#   C:\Users\<user>\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\...（对应 client bundle 目录）
# 然后重启 dsh web（需用户授权）
```

注：源码仓为 0.1.3-alpha.1、安装版为 0.1.1-rc.2——跨版本部署前需在临时环境冒烟（契约 §13 第 6 条）。
