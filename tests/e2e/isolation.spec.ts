import { expect, test } from "@playwright/test";
import { ask, loginDemo, signupFresh, switchWorkspace, workspaceIdFrom } from "./helpers";

/**
 * THE assignment scenario, through the real UI: put a distinctive fact in workspace A, switch to workspace B, ask for it.
 */
test.describe("workspace isolation (through the browser)", () => {
  test("Acme answers with a citation; Beta — same user, same shared store — cannot see it", async ({ page }) => {
    await loginDemo(page);
    await switchWorkspace(page, "Acme Corp");

    await ask(page, "What is the vault access code?");
    await expect(page.getByText("ZEBRA-4417").first()).toBeVisible();
    await expect(page.getByRole("list", { name: "Sources" }).getByText("Acme Corp Employee Handbook")).toBeVisible();

    // The retrieval inspector proves which workspace the chunks came from.
    await page.getByRole("button", { name: "Inspect retrieval" }).first().click();
    await expect(page.getByText("Isolation verified")).toBeVisible();
    await expect(page.getByText("0 from any other workspace")).toBeVisible();
    await page.keyboard.press("Escape");

    // Switch to Beta and ask the identical question.
    await switchWorkspace(page, "Beta Labs");
    await ask(page, "What is the vault access code?");
    await expect(page.getByText("Not in this workspace's documents")).toBeVisible();
    await expect(page.getByText("ZEBRA-4417")).toHaveCount(0);
    expect(await page.content()).not.toContain("ZEBRA");

    // Beta's own knowledge still works, and its documents page shows only Beta's files.
    await ask(page, "What is the escalation phrase used to confirm a sev-1?");
    await expect(page.getByText("orange lantern").first()).toBeVisible();
    await page.getByRole("link", { name: "Documents" }).click();
    await expect(page.getByText("Beta Labs Engineering Onboarding")).toBeVisible();
    await expect(page.getByText("Acme Corp Employee Handbook")).toHaveCount(0);
  });

  test("chat history is per workspace: Acme's conversation list never appears in Beta", async ({ page }) => {
    await loginDemo(page);
    await switchWorkspace(page, "Acme Corp");
    await ask(page, "How many days do customers have to request a refund?");
    await expect(page.getByRole("log").getByText("14 days").first()).toBeVisible();
    await switchWorkspace(page, "Beta Labs");
    await expect(page.getByRole("complementary", { name: "Conversations" }).getByText("refund")).toHaveCount(0);
  });

  test("a different user cannot open someone else's workspace by URL (plain 404, no existence oracle)", async ({ browser, page }) => {
    await loginDemo(page);
    const demoWorkspace = workspaceIdFrom(page.url());
    const ctx = await browser.newContext();
    const other = await ctx.newPage();
    await signupFresh(other);
    const res = await other.goto(`/w/${demoWorkspace}`);
    expect(res?.status()).toBe(404);
    expect(await other.content()).not.toContain("Acme");
    // API too: same answer for a real foreign workspace and a random id.
    const foreign = await other.request.get(`/api/w/${demoWorkspace}/documents`);
    const random = await other.request.get(`/api/w/00000000-0000-4000-8000-000000000000/documents`);
    expect(foreign.status()).toBe(403);
    expect(random.status()).toBe(403);
    expect(await foreign.json()).toEqual({ error: expect.objectContaining({ code: (await random.json()).error.code }) });
    await ctx.close();
  });
});
