import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/infra/auth";

export const dynamic = "force-dynamic";

// Better Auth owns /api/auth/* (sign-up, sign-in, sign-out, session). Its own origin check + our Postgres-backed
// rate limiter (see src/infra/auth.ts) apply to every call.
const handlers = () => toNextJsHandler(auth());
export const GET = (req: Request) => handlers().GET(req);
export const POST = (req: Request) => handlers().POST(req);
