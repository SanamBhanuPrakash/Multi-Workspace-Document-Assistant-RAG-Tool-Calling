import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { withSystem } from "@/infra/db/client";

export const dynamic = "force-dynamic";

/** Liveness + DB reachability. Exposes nothing about configuration, providers or versions. */
export async function GET() {
  try {
    await withSystem((tx) => tx.execute(sql`SELECT 1`));
    return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
