import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === 'production';

/**
 * Policy the app is designed to meet: everything is first-party (fonts are self-hosted by next/font, the browser only
 * calls this app's own /api routes). Next.js needs inline scripts/styles without nonces, and its dev server needs eval
 * and a websocket.
 */
const FULL_CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isProd ? '' : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self'${isProd ? '' : ' ws: wss:'}`,
  "worker-src 'self' blob:",
  "frame-src 'none'",
  "manifest-src 'self'",
].join('; ');

/** Directives that stop framing, injected <base> tags, forms posting elsewhere and plugins. */
const ENFORCED_CSP = [
  "frame-ancestors 'none'",   // nobody may embed the app in a frame (clickjacking)
  "base-uri 'self'",          // an injected <base> cannot redirect relative URLs
  "form-action 'self'",       // forms can only post back to this app
  "object-src 'none'",        // no plugins
].join('; ');

/** The complete policy, enforced: nothing loads from, or is sent to, any other origin. */
const CSP = `${FULL_CSP}; ${ENFORCED_CSP}`;

const securityHeaders = [
  { key: 'Content-Security-Policy', value: CSP },
  { key: 'X-Frame-Options', value: 'DENY' },                       // same as frame-ancestors, for older browsers
  { key: 'X-Content-Type-Options', value: 'nosniff' },             // a response is never reinterpreted as another type
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  ...(isProd ? [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' }] : []),
];

const nextConfig: NextConfig = {
  // pdfkit reads its bundled AFM font files from node_modules at runtime;
  // bundling it breaks those paths, so load it with native require.
  serverExternalPackages: ['pdfkit'],
  // Don't advertise the framework version in a response header.
  poweredByHeader: false,
  devIndicators: false,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
