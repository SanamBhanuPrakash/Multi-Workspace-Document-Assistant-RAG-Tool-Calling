/**
 * Minimal, transparent migration runner: applies db/migrations/*.sql in order, each in its own transaction,
 * recording a checksum so a silently edited historical migration is detected instead of ignored.
 * Statements are split on drizzle's `--> statement-breakpoint` marker.
 *
 * usage: tsx scripts/migrate.ts            (uses DATABASE_URL)
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

export async function migrate(databaseUrl: string, dir = join(process.cwd(), "db", "migrations")): Promise<string[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    // Serialise concurrent runners (CI + local, or two deploys).
    await client.query("SELECT pg_advisory_lock(727274)");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      const sql = readFileSync(join(dir, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const { rows } = await client.query<{ checksum: string }>("SELECT checksum FROM schema_migrations WHERE name = $1", [file]);
      if (rows[0]) {
        if (rows[0].checksum !== checksum) throw new Error(`Migration ${file} was modified after being applied (checksum mismatch).`);
        continue;
      }
      const statements = sql.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
      await client.query("BEGIN");
      try {
        for (const stmt of statements) await client.query(stmt);
        await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [file, checksum]);
        await client.query("COMMIT");
        applied.push(file);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await client.query("SELECT pg_advisory_unlock(727274)");
  } finally {
    await client.end();
  }
  return applied;
}

// CLI entry
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/").split("/").pop() ?? "")) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  migrate(url)
    .then((a) => console.warn(a.length ? `applied: ${a.join(", ")}` : "database is up to date"))
    .catch((e: unknown) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
