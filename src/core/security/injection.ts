/**
 * Ingestion-time prompt-injection heuristics.
 *
 * IMPORTANT — what this is and is not. This is an ADVISORY signal: a flagged chunk is still stored and retrievable, but it
 * (a) shows a visible warning badge in the UI and (b) TAINTS any request whose context contains it, which forces
 * side-effect tools to wait for explicit human confirmation. It is deliberately not the primary defence — pattern lists
 * are always incomplete. The primary defences are structural and hold even if this scanner misses an attack:
 * nonce-fenced untrusted data, a tool allow-list with strict schemas, and workspace identity never coming from the model.
 */
export type InjectionReason =
  | "override"
  | "role_hijack"
  | "system_impersonation"
  | "fence_break"
  | "tool_coercion"
  | "exfiltration"
  | "prompt_leak"
  | "hidden_unicode";

export type InjectionScan = { flagged: boolean; reasons: InjectionReason[] };

const RULES: { reason: InjectionReason; patterns: RegExp[] }[] = [
  {
    reason: "override",
    patterns: [
      /\b(ignore|disregard|override|bypass)\b[^.\n]{0,40}\b(all|any|the|your|every|previous|prior|above|earlier|preceding)\b[^.\n]{0,30}\b(instructions?|rules?|prompts?|guidelines?|directions?|constraints?)\b/i,
      /\bforget\b[^.\n]{0,20}\b(everything|all|what)\b/i,
    ],
  },
  {
    reason: "role_hijack",
    patterns: [
      /\byou are now\b/i,
      /\b(new|updated|revised)\s+(system\s+)?(instructions?|rules?|role|persona)\s*[:\-]/i,
      /\bfrom now on,?\s+(you|respond|answer|act|only)\b/i,
      /\bpretend\s+(to be|you are)\b/i,
    ],
  },
  {
    reason: "system_impersonation",
    patterns: [
      /^\s*#{1,6}\s*(system|assistant|developer)\b/im,
      /<\|(im_start|im_end|system|endoftext)\|>/i,
      /\[\/?INST\]/,
      /^\s*(system|assistant)\s*:\s*\S/im,
    ],
  },
  {
    reason: "fence_break",
    patterns: [/<\/?(retrieved_documents|context|documents?|sources?|system|instructions?)\b[^>]*>/i, /<<<\s*(END-)?SOURCE/i],
  },
  {
    reason: "tool_coercion",
    patterns: [
      // imperative + a snake_case identifier (delete_everything, send_summary …) close by
      /\b(call|invoke|run|execute|trigger)\b[^.\n]{0,40}\b[a-z]+_[a-z_]+\b/i,
      /\b(call|invoke|use)\b[^.\n]{0,20}\b(the\s+)?(tool|function)s?\b[^.\n]{0,25}\b(immediately|now|with|to send|to delete)\b/i,
    ],
  },
  {
    reason: "exfiltration",
    patterns: [
      /\b(send|post|forward|upload|transmit|e-?mail|exfiltrate)\b[^.\n]{0,60}https?:\/\//i,
      /!\[[^\]]*\]\(https?:\/\/[^)\s]*[?&][^)]*\)/i, // markdown image beacon with a query string
    ],
  },
  {
    reason: "prompt_leak",
    patterns: [
      /\b(print|reveal|show|repeat|output|display|leak)\b[^.\n]{0,30}\b(system prompt|your\s+(hidden\s+|secret\s+)?instructions|initial prompt|developer message)\b/i,
    ],
  },
];

export function scanForInjection(text: string, opts: { hiddenCharCount?: number } = {}): InjectionScan {
  const reasons: InjectionReason[] = [];
  for (const rule of RULES) {
    if (rule.patterns.some((p) => p.test(text))) reasons.push(rule.reason);
  }
  if ((opts.hiddenCharCount ?? 0) > 0) reasons.push("hidden_unicode");
  return { flagged: reasons.length > 0, reasons };
}
