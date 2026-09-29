"use client";

import { ArrowRight, Eye, EyeOff, Sparkles } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";
import { authClient, DEMO_ACCOUNT } from "./auth-client";
import { Button, Field, Input } from "./primitives";

type Mode = "login" | "signup";

/** Only same-site relative paths are honoured after sign-in: an attacker-supplied `next` can never bounce a user off-site. */
export const safeNext = (next: string | null | undefined): string => (next && /^\/(?!\/)[\w\-./]*$/.test(next) && !next.includes("..") ? next : "/app");

export function AuthForm({ mode, next }: { mode: Mode; next?: string | undefined }) {
  const router = useRouter();
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [show, setShow] = React.useState(false);
  const [busy, setBusy] = React.useState<"form" | "demo" | null>(null);
  const [error, setError] = React.useState<string>();
  const signup = mode === "signup";

  const fieldErrors = {
    email: email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? "Enter a valid email address." : undefined,
    password: signup && password && password.length < 10 ? "Use at least 10 characters." : undefined,
  };

  async function run(kind: "form" | "demo", creds: { email: string; password: string }) {
    setBusy(kind);
    setError(undefined);
    try {
      const res = signup && kind === "form" ? await authClient.signUp.email({ name: name.trim() || creds.email.split("@")[0]!, ...creds }) : await authClient.signIn.email(creds);
      if (res.error) {
        setError(res.error.status === 429 ? "Too many attempts. Please wait a minute and try again." : signup ? (res.error.message ?? "Could not create the account.") : "Incorrect email or password.");
        return;
      }
      router.replace(safeNext(next));
      router.refresh();
    } catch {
      setError("Network problem. Check your connection and try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="w-full max-w-sm">
      <h1 className="text-2xl font-semibold text-ink">{signup ? "Create your account" : "Welcome back"}</h1>
      <p className="mt-1.5 text-sm text-ink-2">{signup ? "Free. Your workspaces stay sealed from each other." : "Sign in to your workspaces."}</p>

      <form
        className="mt-7 space-y-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (fieldErrors.email || fieldErrors.password || !email || !password) return;
          void run("form", { email: email.trim(), password });
        }}
      >
        {signup ? (
          <Field label="Name" htmlFor="name">
            <Input id="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          </Field>
        ) : null}
        <Field label="Email" htmlFor="email" error={fieldErrors.email}>
          <Input id="email" type="email" inputMode="email" autoComplete={signup ? "email" : "username"} value={email} onChange={(e) => setEmail(e.target.value)} required aria-invalid={!!fieldErrors.email} />
        </Field>
        <Field label="Password" htmlFor="password" error={fieldErrors.password} hint={signup ? "At least 10 characters." : undefined}>
          <div className="relative">
            <Input id="password" type={show ? "text" : "password"} autoComplete={signup ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} required maxLength={128} className="pr-11" aria-invalid={!!fieldErrors.password} />
            <button type="button" onClick={() => setShow((s) => !s)} className="absolute right-1 top-1 grid size-8 place-items-center rounded-md text-ink-2 hover:bg-panel-2 hover:text-ink" aria-label={show ? "Hide password" : "Show password"} aria-pressed={show}>
              {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
        </Field>

        {error ? (
          <p role="alert" className="rounded-md border border-bad/30 bg-bad-soft px-3 py-2 text-sm text-bad">
            {error}
          </p>
        ) : null}

        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy === "form"} disabled={busy !== null}>
          {signup ? "Create account" : "Sign in"}
          <ArrowRight />
        </Button>
      </form>

      {!signup ? (
        <div className="mt-6 rounded-lg border border-line bg-panel-2 p-4">
          <p className="flex items-center gap-2 text-sm font-medium text-ink">
            <Sparkles className="size-4 text-brand" aria-hidden /> Just reviewing?
          </p>
          <p className="mt-1 text-[13px] text-ink-2">Open the throwaway demo account: two preloaded workspaces and sample documents, ready to try the isolation test.</p>
          <Button variant="soft" className="mt-3 w-full" loading={busy === "demo"} disabled={busy !== null} onClick={() => void run("demo", DEMO_ACCOUNT)}>
            Enter demo account
          </Button>
        </div>
      ) : null}

      <p className="mt-6 text-center text-sm text-ink-2">
        {signup ? "Already have an account? " : "New here? "}
        <Link href={signup ? "/login" : "/signup"} className="font-medium text-brand underline-offset-4 hover:underline">
          {signup ? "Sign in" : "Create an account"}
        </Link>
      </p>
    </div>
  );
}
