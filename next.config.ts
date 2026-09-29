import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Server-only packages must never be bundled for the browser.
  serverExternalPackages: ["pg", "pino", "pino-pretty", "unpdf", "mammoth"],
  experimental: {
    // Body size for uploads is enforced again in the route handler; this is the outer bound.
    serverActions: { bodySizeLimit: "6mb" },
  },
  // Security headers that do not need a per-request nonce live here; CSP (nonce) lives in src/proxy.ts.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};

export default config;
