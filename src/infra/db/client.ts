import "server-only";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import pg from "pg";
import type { TenantScope } from "@/core/security/tenant";
import { env } from "../env";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Drizzle wraps driver failures as `Failed query: <sql> params: <every bound value>`. Anything that logs or renders an
 * uncaught error (Next.js does) would print document text, names and ciphertext. We re-throw the DRIVER error instead:
 * same SQLSTATE `code` / `constraint` for callers, no bound parameters in the message.
 */
export class DbError extends Error {
  constructor(
    message: string,
    public readonly code: string | undefined,
    public readonly constraint: string | undefined,
  ) {
    super(message);
    this.name = "DbError";
  }
}

function sanitize(err: unknown): unknown {
  if (err instanceof Error && err.message.startsWith("Failed query:") && err.cause instanceof Error) {
    const c = err.cause as Error & { code?: string; constraint?: string };
    return new DbError(c.message.slice(0, 300), c.code, c.constraint);
  }
  return err;
}

// Survive Next.js dev HMR without leaking pools.
const g = globalThis as unknown as { __latticePool?: pg.Pool };

export function pool(): pg.Pool {
  if (!g.__latticePool) {
    const url = env().DATABASE_URL;
    g.__latticePool = new pg.Pool({
      connectionString: url,
      max: env().NODE_ENV === "production" ? 5 : 10, // Neon free pooler: keep per-instance connections small
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
      ssl: /sslmode=(require|verify)/.test(url) ? { rejectUnauthorized: true } : undefined,
    });
    g.__latticePool.on("error", () => {
      /* idle client errors must not crash the process; the next checkout gets a fresh client */
    });
  }
  return g.__latticePool;
}

export const db = (): Db => drizzle(pool(), { schema });

async function runTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await db().transaction(fn);
  } catch (err) {
    throw sanitize(err);
  }
}

async function applyGuards(tx: Tx): Promise<void> {
  await tx.execute(sql`SET LOCAL statement_timeout = '20s'`);
  await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout = '30s'`);
  // HNSW is approximate and applies row filters AFTER the index scan (this includes RLS policies). Without iterative scans a
  // filtered query can come back short — or empty — when the nearest 100 rows all belong to other tenants (observed once the
  // table held a few thousand foreign rows). Iterative scanning keeps going until enough rows pass the filter. It is set
  // for EVERY tenant transaction so no vector query can forget it.
  await tx.execute(sql`SET LOCAL hnsw.iterative_scan = relaxed_order`);
  await tx.execute(sql`SET LOCAL hnsw.ef_search = 100`);
  await tx.execute(sql`SET LOCAL hnsw.max_scan_tuples = 20000`);
}

/**
 * Run `fn` inside a transaction that is (a) demoted to the RLS-subject `lattice_app` role and (b) scoped to one
 * (user, workspace). This is the ONLY way tenant data is reached; the TenantScope parameter makes forgetting it a
 * compile error, and RLS makes a forgotten WHERE clause return nothing rather than everything.
 */
export async function withTenant<T>(scope: TenantScope, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return runTx(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE lattice_app`);
    await tx.execute(sql`SELECT set_config('app.user_id', ${scope.userId}, true), set_config('app.workspace_id', ${scope.workspaceId}, true)`);
    await applyGuards(tx);
    return fn(tx);
  });
}

/** User-level scope (workspace list/create). No workspace is selected, so workspace-scoped tables return nothing. */
export async function withUser<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!userId) throw new Error("withUser requires a user id");
  return runTx(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE lattice_app`);
    await tx.execute(sql`SELECT set_config('app.user_id', ${userId}, true), set_config('app.workspace_id', '', true)`);
    await applyGuards(tx);
    return fn(tx);
  });
}

/**
 * Privileged path for narrowly-scoped system work (job claiming, the auth library, seeding). Runs as the connection's
 * owner role and therefore BYPASSES RLS. Nothing tenant-facing may call this; it is grep-able on purpose.
 */
export async function withSystem<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return runTx(fn);
}

export async function closePool(): Promise<void> {
  if (g.__latticePool) {
    await g.__latticePool.end();
    g.__latticePool = undefined;
  }
}
