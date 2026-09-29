import { dashboardQueries } from "@/infra/db/queries";
import { json, workspaceRoute } from "../../../_lib/http";

export const dynamic = "force-dynamic";

export const GET = workspaceRoute({}, async ({ scope, requestId }) => json({ conversations: await dashboardQueries.conversations(scope) }, requestId));
