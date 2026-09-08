# dsh-mcp-adapter

**MCP 与连接** — a single DeepSeek Harness (DSH) plugin unifying MCP server management, SSH tunnels/port mappings, and the embedded management engine. Absorbs local-mcp-gateway (MIT) as a plugin-owned child process; no separate gateway install, no :19999 panel to open.

## What you get

- **MCP services**: create/edit/delete/rename/import/export, grouping, ordering, enable/disable, health & process management — over standard `.mcp.json` files (global `~/.agents/.mcp.json`, project `.mcp.json`) and a plugin-private encrypted native catalog (mysql/redis/pg/mongo/rest/echo + third-party adapters).
- **Three scopes**: global / project / session with tombstone disables, whole-entry override, same-level conflict diagnostics, per-session snapshots.
- **Session tools**: registered inside the agent's own scope via the preset-row entry (`dsh-mcp-json-adapter/agent`) behind the awaited setup barrier — per-workspace tool sets, no global leaks, failures isolated per server.
- **SSH & tunnels**: connections (key/password/${ENV} refs, TOFU fingerprints), local port mappings with live stats, reconnect only for retryable failures, port-owner diagnostics.
- **Observability**: per-MCP call logs, traffic ring, process-tree memory, stderr capture; manual Runs are source-attributed (`panel` vs `dsh-session`).
- **Migration**: read-only dry-run + idempotent import from an existing local-mcp-gateway data dir (sealed or legacy plaintext; sources never rewritten).
- **Security**: private stdio IPC between host and engine; the browser reaches management only through the same-origin `/dsh-mcp-manager` bridge behind a loopback/same-origin trust fence; secrets masked in every list DTO and sealed (DPAPI/machine-bound) at rest.

## Install

```bash
npm install -g dsh-mcp-adapter   # or link a checkout into ~/.dsh/profiles/web
```

Enable the plugin-owned engine in your profile's `cordis.patch.yml`:

```yaml
- id: mcp-json-adapter
  name: dsh-mcp-json-adapter
  config:
    project: session
    engine: true        # plugin-owned child engine (ephemeral loopback port)
```

Add the agent-plane row to a preset (`~/.dsh/.agent-presets/<yours>/agent.cordis.yml`) for per-session tools:

```yaml
- id: mcp-session-tools
  name: 'dsh-mcp-json-adapter/agent'
```

Then open **Settings → MCP 与连接** (and the conversation **MCP** tab).

## Scope & timing semantics

- Global/project saves apply to the NEXT session; running sessions keep their registered tool set (snapshot).
- Session-level changes are flagged *pending* until a later session adopts them.
- Standard files stay plain, standard-shaped JSON — the panel and your editor share one source of truth (revision-checked, atomic writes).

## Uninstall / rollback

Disable the plugin (or remove the entry) — the engine child shuts down gracefully and its process ledger is cleaned; your standard files and the sealed private storage under `~/.dsh/mcp-manager/` remain untouched. Legacy `lmg` installs keep working independently.

## Development

```bash
npm ci && npm run build          # tsc + engine assets + esbuild client bundle
npm test                         # host suites (config/IPC/bridge/agent/migration)
npm run test:engine              # migrated engine suites (vitest)
node scripts/pack-check.mjs      # clean-install e2e over npm pack
```

See `docs/`: unified-feature-matrix, dsh-integration-contract, p0-decisions, workspace-menu-extension.

## License

MIT. Engine core migrated from local-mcp-gateway@45884f1 (MIT).
