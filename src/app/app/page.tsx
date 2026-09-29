import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { workspaceRepo } from "@/infra/db/queries";
import { requireUser } from "@/infra/session";

export const dynamic = "force-dynamic";

/** Entry point after sign-in: land in the last-used workspace, creating a first one if the account is brand new. */
export default async function AppIndex() {
  const user = await requireUser();
  const workspaces = await workspaceRepo.ensureFirst(user.id);
  const last = (await cookies()).get("lattice_last_ws")?.value; // only a hint: membership is verified again on the next page
  const target = workspaces.find((w) => w.id === last) ?? workspaces[0]!;
  redirect(`/w/${target.id}`);
}
