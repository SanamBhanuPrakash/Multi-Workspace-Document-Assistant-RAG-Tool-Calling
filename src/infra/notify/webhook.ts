import "server-only";
import type { NotifierPort } from "@/core/ports/providers";
import { ToolError } from "@/core/application/tools/registry";

/**
 * Slack / Discord incoming webhooks.
 *  - the URL was validated to the exact provider shape at save time (see core/security/webhook.ts), and we additionally
 *    refuse redirects, so the server can never be steered to an internal address (SSRF);
 *  - model-authored text is neutralised so it cannot ping @everyone/@channel or smuggle link-unfurl tricks;
 *  - failures are reported WITHOUT the URL (it is a bearer secret).
 */
const neutralise = (s: string): string =>
  s
    .replace(/<!(channel|here|everyone)[^>]*>/gi, "‹!$1›") // Slack broadcast mentions
    .replace(/<@[A-Z0-9]+>/g, "‹@user›")
    .replace(/\r/g, "");

export const webhookNotifier: NotifierPort = {
  async send(kind, webhookUrl, { title, body }, signal) {
    const t = neutralise(title).slice(0, 100);
    const b = neutralise(body);
    const payload =
      kind === "slack"
        ? { text: `*${t}*\n${b}`.slice(0, 3500), unfurl_links: false, unfurl_media: false }
        : { content: `**${t}**\n${b}`.slice(0, 1900), allowed_mentions: { parse: [] as string[] }, flags: 4 /* SUPPRESS_EMBEDS */ };
    let res: Response;
    try {
      res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        redirect: "manual",
        signal: AbortSignal.any([AbortSignal.timeout(8_000), ...(signal ? [signal] : [])]),
      });
    } catch {
      throw new ToolError("delivery_failed", `Could not reach ${kind}. Try again later.`);
    }
    await res.body?.cancel().catch(() => undefined);
    if (res.status >= 300 && res.status < 400) throw new ToolError("delivery_failed", `${kind} responded with a redirect, which is refused.`);
    if (res.status === 404 || res.status === 410) throw new ToolError("webhook_revoked", `The ${kind} webhook no longer exists. A workspace owner should update it in Settings.`);
    if (!res.ok) throw new ToolError("delivery_failed", `${kind} rejected the message (HTTP ${res.status}).`);
  },
};
