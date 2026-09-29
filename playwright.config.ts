import { defineConfig, devices } from "@playwright/test";

/**
 * Browser E2E. Runs the PRODUCTION build against a throwaway database (`lattice_e2e`) with the deterministic offline
 * providers, so results never depend on network access or free-tier rate limits. `tests/e2e/global-setup.ts` recreates the
 * database from the real migrations and seeds the demo data through the real ingestion pipeline.
 *
 *   npm run e2e   (builds first)   ·   npm run e2e:fast   (reuse an existing production build)
 */
const PORT = 3210;
const ADMIN = process.env.TEST_ADMIN_DATABASE_URL ?? "postgres://lattice:lattice_dev@localhost:54329/postgres";
export const E2E_DB_URL = ADMIN.replace(/\/[^/]*$/, "/lattice_e2e");

export const E2E_ENV = {
  NODE_ENV: "production",
  APP_URL: `http://localhost:${PORT}`,
  DATABASE_URL: E2E_DB_URL,
  BETTER_AUTH_SECRET: "e2e-only-secret-e2e-only-secret-1234567",
  ENCRYPTION_KEY: "ZTJlLW9ubHktMzItYnl0ZS1rZXktZm9yLXRlc3RzISE=",
  LLM_PROVIDER: "fake",
  EMBED_PROVIDER: "fake",
  LATTICE_ALLOW_FAKE_PROVIDERS: "1",
  LATTICE_RATE_LIMIT_SCALE: "50", // the suite creates many accounts from one address; guarded to localhost in env.ts
  LOG_LEVEL: "error",
};

export default defineConfig({
  testDir: "tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1, // one shared database; tests create their own users so order does not matter
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}/login`, // NOT /api/health: the web server starts before global setup creates the database
    reuseExistingServer: false,
    timeout: 60_000,
    env: E2E_ENV,
  },
});
