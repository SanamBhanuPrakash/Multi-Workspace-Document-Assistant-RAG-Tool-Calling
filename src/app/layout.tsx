import type { Metadata, Viewport } from "next";
import { Fira_Code, Fira_Sans } from "next/font/google";
import { headers } from "next/headers";
import { Toaster } from "@/ui/toast";
import "./globals.css";

const sans = Fira_Sans({ subsets: ["latin"], weight: ["300", "400", "500", "600", "700"], variable: "--font-fira-sans", display: "swap" });
const mono = Fira_Code({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-fira-code", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Lattice — workspace-isolated AI for your documents", template: "%s · Lattice" },
  description: "Ask questions grounded in your documents, with citations, tool actions, and strict per-workspace isolation on a single shared vector store.",
  robots: { index: false, follow: false }, // a private, sign-in-gated tool
  icons: { icon: "/icon.svg" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f6fb" },
    { media: "(prefers-color-scheme: dark)", color: "#090c12" },
  ],
};

// Runs before first paint so a saved theme never flashes the wrong palette. Nonce-bound (CSP).
const THEME_INIT = `try{var t=localStorage.getItem("lattice-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body>
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-panel focus:px-3 focus:py-2 focus:text-ink focus:shadow-2">
          Skip to content
        </a>
        {children}
        <Toaster />
      </body>
    </html>
  );
}
