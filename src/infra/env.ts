import "server-only";
import { z } from "zod";

/**
 * Single source of truth for configuration. Validated once at first use; the process fails fast with
 * the NAMES of bad variables only — values are never included in errors or logs.
 */
const base64Key32 = z
  .string()
  .refine((v) => {
    try {
      return Buffer.from(v, "base64").length === 32;
    } catch {
      return false;
    }
  }, "must be base64 of exactly 32 bytes");

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    APP_URL: z.url().default("http://localhost:3000"),

    DATABASE_URL: z.string().min(1),

    BETTER_AUTH_SECRET: z.string().min(32, "must be at least 32 characters"),
    ENCRYPTION_KEY: base64Key32,

    LLM_PROVIDER: z.enum(["gemini", "groq", "fake"]).default("gemini"),
    EMBED_PROVIDER: z.enum(["gemini", "fake"]).default("gemini"),
    GEMINI_API_KEY: z.string().min(1).optional(),
    GEMINI_CHAT_MODEL: z.string().default("gemini-2.5-flash"),
    GEMINI_EMBED_MODEL: z.string().default("gemini-embedding-001"),
    GROQ_API_KEY: z.string().min(1).optional(),
    GROQ_MODEL: z.string().default("openai/gpt-oss-120b"),

    /** Explicit opt-in so a mis-set production env can never silently run on fake providers. */
    LATTICE_ALLOW_FAKE_PROVIDERS: z.enum(["0", "1"]).default("0"),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  })
  .superRefine((e, ctx) => {
    const usesFake = e.LLM_PROVIDER === "fake" || e.EMBED_PROVIDER === "fake";
    if (usesFake && e.NODE_ENV === "production" && e.LATTICE_ALLOW_FAKE_PROVIDERS !== "1") {
      ctx.addIssue({ code: "custom", path: ["LLM_PROVIDER"], message: "fake providers are refused in production" });
    }
    if ((e.LLM_PROVIDER === "gemini" || e.EMBED_PROVIDER === "gemini") && !e.GEMINI_API_KEY) {
      ctx.addIssue({ code: "custom", path: ["GEMINI_API_KEY"], message: "required when a Gemini provider is selected" });
    }
    if (e.LLM_PROVIDER === "groq" && !e.GROQ_API_KEY) {
      ctx.addIssue({ code: "custom", path: ["GROQ_API_KEY"], message: "required when LLM_PROVIDER=groq" });
    }
  });

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`))];
    throw new Error(`Invalid environment configuration:\n - ${names.join("\n - ")}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test helper: drop the memoised value. */
export function resetEnvForTests(): void {
  cached = undefined;
}
