import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const resolve = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@grokmax/core": resolve("./packages/core/src/index.ts"),
      "@grokmax/cache": resolve("./packages/cache/src/index.ts"),
      "@grokmax/compiler": resolve("./packages/compiler/src/index.ts"),
      "@grokmax/context": resolve("./packages/context/src/index.ts"),
      "@grokmax/router": resolve("./packages/router/src/index.ts"),
      "@grokmax/ledger": resolve("./packages/ledger/src/index.ts"),
      "@grokmax/artifacts": resolve("./packages/artifacts/src/index.ts"),
      "@grokmax/providers": resolve("./packages/providers/src/index.ts"),
      "@grokmax/adapters": resolve("./packages/adapters/src/index.ts"),
      "@grokmax/telemetry": resolve("./packages/telemetry/src/index.ts"),
      "@grokmax/doctor": resolve("./packages/doctor/src/index.ts")
    }
  },
  test: {
    include: [
      "packages/*/tests/**/*.test.ts",
      "apps/*/tests/**/*.test.ts"
    ],
    testTimeout: 60000,
    hookTimeout: 60000,
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true }
    },
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: ["**/index.ts"]
    }
  }
});