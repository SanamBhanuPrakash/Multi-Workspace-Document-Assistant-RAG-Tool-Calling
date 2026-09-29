import pg from "pg";
import { migrate } from "../scripts/migrate";

/**
 * Integration tests run against a REAL Postgres+pgvector (same image as dev/prod), in a throwaway database that is
 * rebuilt from the real migrations on every run. Isolation is proven against the actual RLS policies, never mocks.
 */
const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? "postgres://lattice:lattice_dev@localhost:54329/postgres";
export const TEST_DB = "lattice_test";
export const TEST_URL = ADMIN_URL.replace(/\/[^/]*$/, `/${TEST_DB}`);

export default async function setup(): Promise<void> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  try {
    await admin.connect();
  } catch (err) {
    throw new Error(
      `Cannot reach Postgres for integration tests (${err instanceof Error ? err.message : String(err)}). Run: npm run db:up`,
    );
  }
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();
  await migrate(TEST_URL);
}
