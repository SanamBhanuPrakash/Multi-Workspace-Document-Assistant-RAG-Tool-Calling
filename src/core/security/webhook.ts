import { DomainError } from "../domain/errors";

/**
 * Webhook URLs are bearer secrets AND an SSRF surface (the server will POST to them). We accept only the two exact
 * provider shapes over https — no arbitrary hosts, no ports, no credentials, no query strings.
 */
export type WebhookKind = "slack" | "discord";

const SLACK = /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/[A-Za-z0-9]+$/;
const DISCORD = /^https:\/\/(?:discord|discordapp)\.com\/api\/webhooks\/\d{5,25}\/[A-Za-z0-9_-]{20,120}$/;

export function validateWebhookUrl(kind: WebhookKind, url: string): string {
  const trimmed = url.trim();
  const ok = kind === "slack" ? SLACK.test(trimmed) : DISCORD.test(trimmed);
  if (!ok) throw new DomainError("validation", `That does not look like a valid ${kind} incoming-webhook URL.`, 400);
  return trimmed;
}

/** Non-secret display hint: host + last 4 characters. Safe to show and to log. */
export function webhookHint(url: string): string {
  const u = new URL(url);
  return `${u.hostname}/…${url.slice(-4)}`;
}
