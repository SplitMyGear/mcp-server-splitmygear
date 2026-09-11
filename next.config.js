/** @type {import('next').NextConfig} */
const nextConfig = {
  // The MCP server holds no database or payment SDKs (ADR 0001): everything
  // goes through the backend REST API, so nothing needs to be externalised.
  poweredByHeader: false,
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
