import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { ask, signupFresh, switchWorkspace, workspaceIdFrom } from "./helpers";

const FIX = (f: string) => join(process.cwd(), "fixtures", f);

/** Opt-in sharing through the real UI: default isolation, explicit grant, read-only evidence in the inspector, instant revoke. */
test.describe("opt-in cross-workspace sharing (through the browser)", () => {
  test("nothing crosses by default; Share makes one document citable in the other workspace; Stop sharing revokes at once", async ({ page }) => {
    await signupFresh(page);
    const origin = new URL(page.url()).origin;
    const created = await page.request.post("/api/workspaces", { data: { name: "Partner" }, headers: { origin } });
    expect(created.status()).toBe(201);

    // Put the Acme handbook into the first workspace.
    await page.getByRole("link", { name: "Documents" }).click();
    await page.getByLabel("Choose files to upload").setInputFiles(FIX("docs/acme-handbook.md"));
    await expect(page.getByRole("list", { name: "Documents" }).getByText("Ready")).toBeVisible({ timeout: 30_000 });
    const home = workspaceIdFrom(page.url());

    // Default: the other workspace cannot answer from it.
    await page.reload();
    await switchWorkspace(page, "Partner");
    await ask(page, "What is the vault access code?");
    await expect(page.getByText("Not in this workspace's documents")).toBeVisible();
    await expect(page.getByText("ZEBRA-4417")).toHaveCount(0);

    // Grant through the dialog.
    await page.goto(`/w/${home}/documents`);
    await page.getByRole("button", { name: /Share/ }).first().click();
    const dialog = page.getByRole("dialog", { name: "Share document" });
    await dialog.getByRole("button", { name: "Share", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Stop sharing" })).toBeVisible();
    await page.keyboard.press("Escape");

    // The Partner workspace now answers with a citation, and the inspector labels the source as shared in.
    await switchWorkspace(page, "Partner");
    await ask(page, "What is the vault access code again?");
    await expect(page.getByText("ZEBRA-4417").first()).toBeVisible();
    await page.getByRole("button", { name: "Inspect retrieval" }).last().click();
    await expect(page.getByText(/explicitly shared in/)).toBeVisible();
    await expect(page.getByText("0 from any other workspace")).toBeVisible(); // shared-in rows are declared, not violations
    await page.keyboard.press("Escape");

    // Revoke: gone immediately.
    await page.goto(`/w/${home}/documents`);
    await page.getByRole("button", { name: /Share/ }).first().click();
    await page.getByRole("dialog", { name: "Share document" }).getByRole("button", { name: "Stop sharing" }).click();
    await expect(page.getByRole("dialog", { name: "Share document" }).getByRole("button", { name: "Share", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await switchWorkspace(page, "Partner");
    await ask(page, "What is the vault access code one more time?");
    await expect(page.getByText("Not in this workspace's documents").last()).toBeVisible();
  });
});
