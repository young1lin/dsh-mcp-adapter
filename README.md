# @young1lin/dsh-mcp-adapter (mcp-only branch)

**MCP 与连接** — a DeepSeek Harness (DSH) plugin that does exactly one thing: mount MCP servers into every session's own agent scope, hosted by a plugin-owned engine child. This is the **mcp-only** branch — the SSH tunnels, database browsers (mysql/redis/pg/mongo/rest adapters), traffic ring, backup/migration and the standalone `lmg` gateway form were surgically removed. `main` carries the full build.

## What you get

- **MCP services**: create/edit/delete/rename/import, grouping, ordering, enable/disable, health & process management — over standard `.mcp.json` files (global `~/.agents/.mcp.json`, project `.mcp.json`) and a plugin-private encrypted native catalog (proc/http/echo + third-party adapters).
- **Three scopes**: global / project / session with tombstone disables, whole-entry override, same-level conflict diagnostics, per-session snapshots.
- **Session tools**: the HOST registers them inside each session's own agent scope behind the awaited setup barrier — per-workspace tool sets, no global leaks, failures isolated per server. **No preset changes needed; this plugin adds no preset and never asks you to author one.**
- **MCP endpoint**: optionally publish one HTTP port fronting every configured MCP, with named bearer tokens for external clients.
- **Observability**: per-MCP call logs (source-attributed `panel` vs `dsh-session`), process-tree memory, stderr capture.
- **Security**: private stdio IPC between host and engine; the browser reaches management only through the same-origin `/dsh-mcp-manager` bridge behind a loopback/same-origin trust fence; secrets masked in every list DTO and sealed (DPAPI/machine-bound) at rest.

This build is **engine-only**: without `engine: true` the plugin refuses to start with a clear error instead of silently mounting nothing.

## Install

```bash
dsh plugin add @young1lin/dsh-mcp-adapter   # or link a checkout into ~/.dsh/profiles/web
```

Enable the plugin-owned engine in your profile's `cordis.patch.yml`:

```yaml
- id: mcp-json-adapter
  name: '@young1lin/dsh-mcp-adapter'
  config:
    project: session
    engine: true        # required on this branch (plugin-owned child engine)
```

That is the whole setup. Session tools mount host-side into every session's own scope — **no preset additions, no preset edits, ever**. Then open **Settings → MCP 与连接** (and the conversation **MCP** tab).

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
