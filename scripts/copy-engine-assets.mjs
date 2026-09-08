// Copy non-TypeScript assets the compiled engine reads at runtime (tsc emits only .ts -> .js):
// the admin panel tree under src/engine/admin must land in dist/engine/admin, beside the compiled
// admin.ts that serves it (mirrors the upstream local-mcp-gateway copy-assets step).
import { cpSync, mkdirSync, rmSync } from "node:fs";

mkdirSync("dist/engine", { recursive: true });
rmSync("dist/engine/admin", { recursive: true, force: true });
cpSync("src/engine/admin", "dist/engine/admin", { recursive: true });
console.log("copied src/engine/admin -> dist/engine/admin");
