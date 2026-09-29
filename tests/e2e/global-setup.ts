import { execFileSync } from "node:child_process";
import pg from "pg";
import { migrate } from "../../scripts/migrate";
import { E2E_DB_URL, E2E_ENV } from "../../playwright.config";

/** Rebuild the e2e database from the real migrations, then seed the demo data through the real ingestion pipeline. */
export default async function setup(): Promise<void> {
  const admin = new pg.Client({ connectionString: E2E_DB_URL.replace(/\/[^/]*$/, "/postgres") });
  try {
    await admin.connect();
  } catch (err) {
    throw new Error(`Postgres is not reachable for e2e (${err instanceof Error ? err.message : String(err)}). Run: npm run db:up`);
  }
  await admin.query("DROP DATABASE IF EXISTS lattice_e2e WITH (FORCE)");
  await admin.query("CREATE DATABASE lattice_e2e");
  await admin.end();
  await migrate(E2E_DB_URL);
  execFileSync("npx", ["tsx", "--conditions=react-server", "scripts/seed.ts"], {
    stdio: "pipe",
    shell: true,
    env: { ...process.env, ...E2E_ENV, NODE_ENV: "development" }, // seed runs outside Next: it needs the same fake providers
  });
}
