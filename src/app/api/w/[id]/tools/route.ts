import { toolCallRepo } from "@/infra/db/repositories";
import { json, workspaceRoute } from "../../../_lib/http";

export const dynamic = "force-dynamic";

/** The tool-call log: every proposed call — including rejected, held and failed ones — is recorded and shown. */
export const GET = workspaceRoute({}, async ({ scope, requestId }) => json({ toolCalls: await toolCallRepo.list(scope, 100) }, requestId));
