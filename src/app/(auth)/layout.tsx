import Link from "next/link";
import { Lock, ShieldCheck, Wrench } from "lucide-react";
import { Logo } from "@/ui/logo";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[1fr_minmax(0,520px)]">
      <aside className="relative hidden overflow-hidden border-r border-line bg-panel lg:block">
        <div className="lattice-bg absolute inset-0 opacity-70" aria-hidden />
        <div className="relative flex h-full flex-col justify-between p-12">
          <Link href="/" aria-label="Lattice home">
            <Logo />
          </Link>
          <div className="max-w-md">
            <h2 className="text-3xl font-semibold leading-tight text-ink">Answers from your documents. Never from anyone else&apos;s.</h2>
            <ul className="mt-8 space-y-5 text-sm text-ink-2">
              <li className="flex gap-3">
                <Lock className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden />
                <span>
                  <b className="text-ink">Sealed workspaces.</b> One shared vector store, four independent layers keeping each tenant&apos;s data apart.
                </span>
              </li>
              <li className="flex gap-3">
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden />
                <span>
                  <b className="text-ink">Grounded or honest.</b> Every claim cites a source, or the assistant says it doesn&apos;t know.
                </span>
              </li>
              <li className="flex gap-3">
                <Wrench className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden />
                <span>
                  <b className="text-ink">Actions you can audit.</b> Every tool call is validated, logged, and held for your approval when a document looks hostile.
                </span>
              </li>
            </ul>
          </div>
          <p className="text-xs text-ink-3">Free-tier stack · Postgres + pgvector · No card required</p>
        </div>
      </aside>
      <main id="main" className="grid place-items-center px-6 py-12">
        <div className="w-full max-w-sm">
          <Link href="/" className="mb-10 inline-block lg:hidden" aria-label="Lattice home">
            <Logo />
          </Link>
          {children}
        </div>
      </main>
    </div>
  );
}
