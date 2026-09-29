import { expect, type Page } from "@playwright/test";

export const DEMO = { email: "demo@lattice.demo", password: "Lattice-Demo-2026!" };

export async function loginDemo(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByRole("button", { name: "Enter demo account" }).click();
  await page.waitForURL(/\/w\/[0-9a-f-]{36}/);
}

/** Creates a brand-new account through the real sign-up form and lands in its first workspace. */
export async function signupFresh(page: Page): Promise<{ email: string; password: string }> {
  const email = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const password = "E2e-Password-2026!";
  await page.goto("/signup");
  await page.getByLabel("Name").fill("E2E User");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/w\/[0-9a-f-]{36}/);
  return { email, password };
}

export const workspaceIdFrom = (url: string): string => /\/w\/([0-9a-f-]{36})/.exec(url)![1]!;

export async function switchWorkspace(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: /Switch workspace/ }).click();
  await page.getByRole("menuitem", { name: new RegExp(name) }).click();
  await expect(page.getByRole("button", { name: new RegExp(`Workspace: ${name}`) })).toBeVisible();
}

export async function ask(page: Page, text: string): Promise<void> {
  const box = page.getByRole("textbox", { name: "Message" });
  await box.fill(text);
  await box.press("Enter");
}
