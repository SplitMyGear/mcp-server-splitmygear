/** @type {import('next').NextConfig} */
const nextConfig = {
  // The MCP server holds no database or payment SDKs (ADR 0001): everything
  // goes through the backend REST API, so nothing needs to be externalised.
  poweredByHeader: false,
  eslint: {
    // Lint is its own gate: `npm run lint` (eslint.config.mjs), which covers
    // every source file in the repo. Next's build-time runner cannot drive a
    // flat config — next/dist/lib/eslint/runLintCheck.js hardcodes the
    // eslintrc-era `useEslintrc` option, which the flat-config ESLint class
    // rejects ("Invalid Options: Unknown options: useEslintrc, extensions").
    // Before SPLIT-1450 this step found no config and silently linted nothing,
    // so nothing is being switched off here — only a broken duplicate of a
    // gate that now actually runs.
    ignoreDuringBuilds: true,
  },
  async headers() {
    return [
      {
        // Baseline hardening for every response; the API/OAuth routes set
        // their own stricter CORS/CSP/no-store headers on top.
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
