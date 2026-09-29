import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const src = fileURLToPath(new URL("./src", import.meta.url));
const adminUrl = process.env.TEST_ADMIN_DATABASE_URL ?? "postgres://lattice:lattice_dev@localhost:54329/postgres";

export default defineConfig({
  resolve: {
    alias: {
      "@": src,
      "server-only": fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url)),
    },
  },
  test: {
    include: ["tests/unit/**/*.test.{ts,tsx}", "tests/integration/**/*.test.ts", "tests/evals/**/*.test.ts"],
    environment: "node",
    globalSetup: ["tests/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // One shared Postgres: files run serially; each test creates its own users/workspaces with unique ids.
    fileParallelism: false,
    // Non-secret constants for the test process only.
    env: {
      NODE_ENV: "test",
      DATABASE_URL: adminUrl.replace(/\/[^/]*$/, "/lattice_test"),
      APP_URL: "http://localhost:3000",
      BETTER_AUTH_SECRET: "test-only-secret-test-only-secret-1234567890",
      ENCRYPTION_KEY: "dGVzdC1vbmx5LTMyLWJ5dGUta2V5LWZvci10ZXN0cyE=",
      LLM_PROVIDER: "fake",
      EMBED_PROVIDER: "fake",
      LOG_LEVEL: "error",
    },
  },
});
