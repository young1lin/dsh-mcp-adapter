# @young1lin/dsh-mcp-adapter (mcp-only branch)

**MCP 与连接** — a DeepSeek Harness (DSH) plugin that does exactly one thing: mount MCP servers into every session's own agent scope, hosted by a plugin-owned engine child. This is the **mcp-only** branch — the SSH tunnels, database browsers (mysql/redis/pg/mongo/rest adapters), traffic ring, backup/migration and the standalone `lmg` gateway form were surgically removed. `main` carries the full build.

## What you get

- **MCP services**: create/edit/delete/rename/import, grouping, ordering, enable/disable, health & process management — over standard `.mcp.json` files (global `~/.agents/.mcp.json`, project `.mcp.json`) and a plugin-private encrypted native catalog (proc/http/echo + third-party adapters).
- **Three scopes**: global / project / session with tombstone disables, whole-entry override, same-level conflict diagnostics, per-session snapshots.
- **Session tools**: the HOST registers them inside each session's own agent scope behind the awaited setup barrier — per-workspace tool sets, no global leaks, failures isolated per server. **No preset changes needed; this plugin adds no preset and never asks you to author one.**
- **MCP services page**: configure, start/stop, inspect tools/resources/prompts, execute tools, view per-MCP call logs (source-attributed `panel` vs `dsh-session`) and stderr. The Advanced page, public HTTP MCP endpoint, token management, and memory diagnostics are not offered.
- **Security**: private stdio IPC between host and engine; the browser reaches management only through the same-origin `/dsh-mcp-manager` bridge behind a loopback/same-origin trust fence; secrets masked in every list DTO and sealed (DPAPI/machine-bound) at rest.

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

## Scope & timing semantics

- Global/project saves apply to the NEXT session; running sessions keep their registered tool set (snapshot).
- Session-level changes are flagged *pending* until a later session adopts them.
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
