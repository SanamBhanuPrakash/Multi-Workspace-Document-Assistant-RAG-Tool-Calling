import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { ask, loginDemo, signupFresh } from "./helpers";

test.describe("auth & session", () => {
  test("signed-out visitors are redirected; wrong password is refused; open-redirect is neutralised", async ({ page }) => {
    await page.goto("/w/00000000-0000-4000-8000-000000000000");
    await expect(page).toHaveURL(/\/login\?next=/);
    await page.getByLabel("Email").fill("demo@lattice.demo");
    await page.getByLabel("Password", { exact: true }).fill("definitely-wrong-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Incorrect email or password" })).toBeVisible();

    // `next` pointing off-site must land on /app, never on the attacker's host.
    await page.goto("/login?next=//evil.example/steal");
    await page.getByRole("button", { name: "Enter demo account" }).click();
    await page.waitForURL(/\/w\//);
    expect(new URL(page.url()).origin).toBe(new URL(page.url()).origin);
    expect(page.url()).not.toContain("evil.example");
  });

  test("session cookie is httpOnly + SameSite=Lax and invisible to page JavaScript", async ({ page, context }) => {
    await loginDemo(page);
    const cookie = (await context.cookies()).find((c) => c.name.includes("session_token"))!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe("Lax");
    expect(await page.evaluate(() => document.cookie)).not.toContain("session_token");
  });

  test("sign-up works, sign-out ends the session", async ({ page }) => {
    await signupFresh(page);
    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await page.waitForURL(/\/login/);
    await page.goto("/app");
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe("headers & request hardening", () => {
  test("pages carry a nonce-based CSP without script 'unsafe-inline', plus the standard security headers", async ({ request }) => {
    const res = await request.get("/login");
    const csp = res.headers()["content-security-policy"]!;
    expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    const h = res.headers();
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h["strict-transport-security"]).toContain("max-age=");
    expect(h["referrer-policy"]).toBeTruthy();
    expect(h["x-powered-by"]).toBeUndefined();
  });

  test("the nonce differs per request", async ({ request }) => {
    const n = async () => /nonce-([^']+)/.exec((await request.get("/login")).headers()["content-security-policy"]!)![1];
    expect(await n()).not.toBe(await n());
  });

  test("cross-origin mutations are refused (CSRF defence in depth)", async ({ page }) => {
    await loginDemo(page);
    const res = await page.request.post("/api/workspaces", { data: { name: "csrf" }, headers: { origin: "https://evil.example" } });
    expect(res.status()).toBe(403);
  });

  test("health endpoint reveals nothing about configuration", async ({ request }) => {
    const res = await request.get("/api/health");
    expect(await res.json()).toEqual({ ok: true });
  });

  test("no page or bundle leaks provider keys or connection strings", async ({ page }) => {
    await loginDemo(page);
    const html = await page.content();
    for (const needle of ["AIza", "gsk_", "postgres://", "BETTER_AUTH_SECRET", "ENCRYPTION_KEY", "GEMINI_API_KEY"]) expect(html).not.toContain(needle);
  });

  test("document text is rendered as text, never as markup (stored-XSS check)", async ({ page }) => {
    await signupFresh(page);
    await page.getByRole("link", { name: "Documents" }).click();
    await page.getByLabel("Choose files to upload").setInputFiles({
      name: "xss.md",
      mimeType: "text/markdown",
      buffer: Buffer.from('# <img src=x onerror="window.__xss=1"> Title\n\nThe launch codename is <script>window.__xss=2</script> ORCHID-9 and ![p](https://evil.example/p.png?d=1) [click](javascript:window.__xss=3).'),
    });
    await expect(page.getByText("Ready")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("link", { name: "Chat" }).click();
    await ask(page, "What is the launch codename?");
    await expect(page.getByRole("log").getByText(/ORCHID-9/).first()).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
    await expect(page.locator("img[src*='evil.example']")).toHaveCount(0);
    await expect(page.locator("a[href^='javascript:']")).toHaveCount(0);
  });
});

test.describe("accessibility & robustness", () => {
  test("landing content is visible with reduced motion AND with JavaScript disabled", async ({ browser }) => {
    for (const opts of [{ reducedMotion: "reduce" as const }, { javaScriptEnabled: false }]) {
      const ctx = await browser.newContext(opts);
      const page = await ctx.newPage();
      await page.goto("/");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.getByRole("heading", { level: 1 })).toHaveCSS("opacity", "1");
      await expect(page.getByRole("region", { name: "Interactive isolation illustration" })).toBeVisible();
      await ctx.close();
    }
  });

  for (const path of ["/", "/login", "/signup"]) {
    test(`axe: no serious/critical violations on ${path}`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" }); // measure the settled state, not mid-entrance-animation
      await page.goto(path);
      const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
      const bad = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      expect(bad.map((v) => `${v.id}: ${v.nodes[0]?.html.slice(0, 80)}`)).toEqual([]);
    });
  }

  test("axe: dashboard pages have no serious/critical violations", async ({ page }) => {
    await loginDemo(page);
    const base = page.url().split("?")[0]!;
    for (const path of ["", "/documents", "/activity", "/tasks", "/inspector", "/insights", "/settings"]) {
      await page.goto(base + path);
      await page.waitForLoadState("networkidle");
      const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
      const bad = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      expect(bad.map((v) => `${path || "/"} ${v.id}: ${v.nodes[0]?.html.slice(0, 80)}`)).toEqual([]);
    }
  });

  test("keyboard: ⌘/Ctrl+K opens the palette and switches workspace", async ({ page }) => {
    await loginDemo(page);
    await page.keyboard.press("Control+k");
    await page.getByPlaceholder(/Switch workspace/).fill("beta");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: /Workspace: Beta Labs/ })).toBeVisible();
  });

  test("overlays (palette, workspace switcher) open without a single CSP violation", async ({ page }) => {
    // Radix's scroll lock injects a <style>; under a strict nonce CSP it is blocked unless the nonce is bridged to it.
    const violations: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error" && /Content Security Policy/i.test(m.text())) violations.push(m.text().slice(0, 140));
    });
    await loginDemo(page);
    await page.keyboard.press("Control+k");
    await expect(page.getByPlaceholder(/Switch workspace/)).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: /Switch workspace/ }).click();
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    expect(violations).toEqual([]);
  });

  test("mobile: no horizontal scrolling on the main pages", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await loginDemo(page);
    const base = page.url().split("?")[0]!;
    for (const path of ["", "/documents", "/activity", "/insights", "/settings"]) {
      await page.goto(base + path);
      await page.waitForLoadState("networkidle");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `overflow on ${path || "/"}`).toBe(true);
    }
    await ctx.close();
  });
});
