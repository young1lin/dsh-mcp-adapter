# @young1lin/dsh-mcp-adapter (mcp-only branch)

**MCP 与连接** — a DeepSeek Harness (DSH) plugin that does exactly one thing: mount MCP servers into every session's own agent scope, hosted by a plugin-owned engine child. This is the **mcp-only** branch — the SSH tunnels, database browsers (mysql/redis/pg/mongo/rest adapters), traffic ring, backup/migration and the standalone `lmg` gateway form were surgically removed. `main` carries the full build.

## What you get

- **MCP services**: create/edit/delete/rename/import, grouping, ordering, enable/disable, health & process management — over standard `.mcp.json` files (global `~/.agents/.mcp.json`, project `.mcp.json`) and a plugin-private encrypted native catalog (proc/http/echo + third-party adapters).
- **Three scopes**: global / project / session with tombstone disables, whole-entry override, same-level conflict diagnostics, per-session snapshots.
- **Session tools**: the HOST registers them inside each session's own agent scope behind the awaited setup barrier — per-workspace tool sets, no global leaks, failures isolated per server. **No preset changes needed; this plugin adds no preset and never asks you to author one.**
- **MCP services page**: configure, start/stop, inspect tools/resources/prompts, execute tools, view per-MCP call logs (source-attributed `panel` vs `dsh-session`) and stderr. The Advanced page, public HTTP MCP endpoint, token management, and memory diagnostics are not offered.
- **Security**: private stdio IPC between host and engine; the browser reaches management only through the same-origin `/dsh-mcp-manager` bridge behind a loopback/same-origin trust fence; secrets masked in every list DTO and sealed (DPAPI/machine-bound) at rest.

In **Add MCP → JSON**, paste either a single server definition or a whole `{ "mcpServers": { "name": { … } } }` document. The first server is selected and its name is filled automatically; other servers are not saved by this single-entry editor (use bulk import for all entries). HTTP URL/headers and stdio command/args/env are supported; native/session targets convert stdio to a complete proc command line without discarding unknown options. Optional fields fold under **Advanced settings**.

This build is **engine-only**: the engine starts by default; only explicitly setting `engine: false` is refused.

## Install

```bash
dsh plugin add @young1lin/dsh-mcp-adapter   # or link a checkout into ~/.dsh/profiles/web
```

Mount it by package name in your profile's `cordis.patch.yml` — this is the whole entry:

```yaml
- id: mcp-json-adapter
  name: '@young1lin/dsh-mcp-adapter'
```

No `engine` key needed: the plugin-owned engine child is **on by default**. An `engine` block can override `storageDir` / `respawn` / `startupTimeoutMs` / `sessionTools`. Legacy `httpPort` / `publicMcp` values are accepted for compatibility but **ignored**; old `listener.json` settings are also ignored. The engine never listens on HTTP, and existing files and secrets are not deleted. Session tools mount host-side into every session's own scope — **no preset additions or edits** (`engine: false` is refused).

Then open **Settings → MCP 与连接 → MCP Services** (and the conversation **MCP** tab). There is no Advanced tab.

### What is the "engine"?

One private child process (`dist/engine/ipc-main.js`) the plugin spawns itself: it hosts every MCP you configure (proc children, http proxies), keeps the call log, and talks to the dsh host process over a stdio pipe nothing else can reach. If an MCP crashes, the engine dies and respawns — dsh itself never goes down with it. It is inside the package: nothing to install separately, and no HTTP port is opened.

### Source install (the mcp-only branch)

```bash
git clone -b mcp-only https://github.com/young1lin/dsh-mcp-adapter.git
cd dsh-mcp-adapter && npm install && npm run build   # dist/ is required; git has no prebuilt one
```

Then link the checkout into the profile (`~/.dsh/profiles/web/node_modules/@young1lin/dsh-mcp-adapter` → this repo) and use the same two-line patch entry above. After pulling new commits: `npm run build`, restart dsh web.

## Config discovery & deduplication

Default standard sources, lowest precedence first:

- Global: `~/.claude/.mcp.json` → `~/.agents/.mcp.json`.
- Project: `.claude/.mcp.json` → root `.mcp.json` → `.agents/.mcp.json`.
- Across scopes: global → project → session.

Merge by MCP name, replacing whole entries rather than stitching fields; `disabled: true` masks lower sources. Identical definitions under different names share one engine instance while keeping their tool namespaces. Same-scope standard/native clashes remain explicit conflicts. Discovery never migrates or rewrites files; edits target the original source and its revision. Missing files are normal; malformed files/entries are diagnosed and isolated from healthy servers. The misspelling `.cluade` is not a config directory.

An explicit non-default `globalFile` still pins one global standard file instead of loading the default pair, preventing unexpected home-directory tools.

Release changes: [CHANGELOG](CHANGELOG.md).

## Scope & timing semantics

- Global/project saves apply to the NEXT session; running sessions keep their registered tool set (snapshot).
- The conversation MCP tab defaults to its frozen catalog, grouped by MCP with expandable tools. Registration is not a realtime online/health indicator. Refresh is read-only and cannot register, execute, or replace tools.
- **New-session config** is an opt-in global/project preview for this conversation's recorded workspace. Old-session overrides are NOT automatically copied by creating a new conversation. Their storage/API remain available, but the conversation view does not offer misleading hot-edit controls.
- Valid v2 snapshots replay their frozen tool names/descriptions/schemas and raw definitions even after configuration changes. If a frozen server cannot return, the same descriptors remain with a local unavailable error. Legacy, unreadable or malformed generations fail closed instead of substituting current config. Environment references in raw templates may re-resolve when the engine restarts; this is not a promise to pin concrete resolved credentials/endpoints.
- The page centers within the actual pane and reflows as it resizes. The latest DSH chat-width hit strips are hidden only while this MCP view is mounted, not the outer pane splitter or Chat handles.
- Restart DSH, then refresh the page after rebuilding the plugin. A still-running old backend keeps its snapshot view usable and hides the unverified future-config entry; it does not require a DSH version upgrade.
- Standard files stay plain, standard-shaped JSON — the panel and your editor share one source of truth (revision-checked, atomic writes).

## Uninstall / rollback

Disable the plugin (or remove the entry) — the engine child shuts down gracefully and its process ledger is cleaned; your standard files and the sealed private storage under `~/.dsh/mcp-manager/` remain untouched.

## Development

```bash
npm ci && npm run build          # tsc + esbuild client bundle
npm test                         # host suites (config/IPC/bridge/agent/client)
npm run test:engine              # engine suites (vitest)
```

See `docs/`: dsh-integration-contract (the host contract), workspace-menu-extension.

## License

MIT. Engine core migrated from local-mcp-gateway@45884f1 (MIT).
