import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { ask, signupFresh, workspaceIdFrom } from "./helpers";

const FIX = (f: string) => join(process.cwd(), "fixtures", f);

test.describe("documents, idempotent ingestion, tools", () => {
  test("upload two documents → indexed; re-uploading the same file creates no duplicate; bad types are refused", async ({ page }) => {
    await signupFresh(page);
    await page.getByRole("link", { name: "Documents" }).click();
    const input = page.getByLabel("Choose files to upload");

    await input.setInputFiles([FIX("docs/acme-handbook.md"), FIX("docs/acme-security-policy.md")]);
    const list = page.getByRole("list", { name: "Documents" });
    await expect(list.getByText("Ready")).toHaveCount(2, { timeout: 30_000 });
    await expect(list.getByRole("listitem")).toHaveCount(2);

    // Idempotency: same content again → still 2 documents, and the user is told why.
    await input.setInputFiles(FIX("docs/acme-handbook.md"));
    await expect(page.getByText("already in this workspace")).toBeVisible();
    await expect(list.getByRole("listitem")).toHaveCount(2);

    // Refused: wrong type (extension) and a binary disguised as text.
    await input.setInputFiles({ name: "run.exe", mimeType: "application/octet-stream", buffer: Buffer.from("MZ\x90\x00\x03 not text") });
    await expect(page.getByText(/Supported types|binary|reject/i).first()).toBeVisible();
    await expect(list.getByRole("listitem")).toHaveCount(2);

    // And the chat can now answer from what was just uploaded.
    await page.getByRole("link", { name: "Chat" }).click();
    await ask(page, "How much paid annual leave do full-time employees get?");
    await expect(page.getByRole("log").getByText("25 days").first()).toBeVisible();
  });

  test("an oversized upload is refused up front with our error envelope (Vercel's own 4.5 MB body cap would otherwise answer first)", async ({ page }) => {
    await signupFresh(page);
    const ws = workspaceIdFrom(page.url());
    const origin = new URL(page.url()).origin;
    const res = await page.request.post(`/api/w/${ws}/documents`, {
      headers: { origin },
      multipart: { files: { name: "big.txt", mimeType: "text/plain", buffer: Buffer.alloc(4_600_000, "a") } },
    });
    expect(res.status()).toBe(413);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("payload_too_large");
    expect(body.error.message).toMatch(/4 MB/);
  });

  test("the hostile document is flagged, still answerable as data, and never causes an action", async ({ page }) => {
    await signupFresh(page);
    await page.getByRole("link", { name: "Documents" }).click();
    await page.getByLabel("Choose files to upload").setInputFiles(FIX("adversarial/vendor-notes-INJECTION-TEST.md"));
    await expect(page.getByText(/1 flagged/)).toBeVisible({ timeout: 30_000 });
    await page.getByRole("link", { name: "Chat" }).click();
    await ask(page, "What do widgets cost when ordering one hundred units?");
    await expect(page.getByRole("log").getByText(/40 dollars/).first()).toBeVisible();
    // No tool ran, no task exists.
    await page.getByRole("link", { name: "Tool log" }).click();
    await expect(page.getByText("delete_everything")).toHaveCount(0);
    await page.getByRole("link", { name: "Tasks" }).click();
    await expect(page.getByText("PWNED")).toHaveCount(0);
  });

  test("asking for a task really saves it in THIS workspace; it shows in Tasks and in the Tool log", async ({ page }) => {
    await signupFresh(page);
    await ask(page, "save a task: renew the vault code by Friday");
    await expect(page.getByText("Save task")).toBeVisible();
    await expect(page.getByText("Done", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Tasks" }).click();
    await expect(page).toHaveURL(/\/tasks$/);
    await expect(page.getByRole("main").getByText("renew the vault code by Friday", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Tool log" }).click();
    await expect(page).toHaveURL(/\/activity$/);
    await expect(page.getByText("save_task")).toBeVisible();
    await expect(page.getByText("Succeeded")).toBeVisible();
    // Creating another workspace: the task does not follow you there.
    const ws = workspaceIdFrom(page.url());
    const created = await page.request.post("/api/workspaces", { data: { name: "Second" }, headers: { origin: new URL(page.url()).origin } });
    const { workspace } = (await created.json()) as { workspace: { id: string } };
    await page.goto(`/w/${workspace.id}/tasks`);
    // (The page's own help text quotes this sentence as an example, so match the task ROW exactly and assert the empty state.)
    await expect(page.getByText("No tasks yet")).toBeVisible();
    await expect(page.getByText("renew the vault code by Friday", { exact: true })).toHaveCount(0);
    expect(ws).not.toBe(workspace.id);
  });

  test("asking to send a summary with no webhook configured fails politely instead of pretending", async ({ page }) => {
    await signupFresh(page);
    await ask(page, "send a summary to slack");
    await expect(page.getByText("I could not do that").first()).toBeVisible();
    await expect(page.getByText("Failed").first()).toBeVisible();
  });
});
