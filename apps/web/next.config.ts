import type { NextConfig } from "next";

const runtimeUrl = process.env.RUNTIME_INTERNAL_URL ?? "http://127.0.0.1:4000";
const eventsOrigin = process.env.NEXT_PUBLIC_EVENTS_ORIGIN ?? "";

/**
 * Production only: the dev server needs eval. Next's app router injects inline scripts, so without per-request
 * nonces script-src keeps 'unsafe-inline'; the policy still forbids framing, plugins, base rewrites and foreign
 * form targets, and limits network calls to this origin and the agent runtime's event stream.
 */
const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  `connect-src 'self'${eventsOrigin ? ` ${eventsOrigin}` : ""}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const config: NextConfig = {
  reactStrictMode: true,
  agentRules: false,
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
  poweredByHeader: false,
  async rewrites() {
    return [{ source: "/api/v1/:path*", destination: `${runtimeUrl}/api/v1/:path*` }];
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          ...(process.env.NODE_ENV === "production" ? [{ key: "Content-Security-Policy", value: contentSecurityPolicy }] : []),
        ],
      },
    ];
  },
};

export default config;
