import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { environment: "node", include: ["test/engine/**/*.test.ts"], setupFiles: ["./test/engine/setup.ts"] },
});
