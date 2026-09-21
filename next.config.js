/** @type {import('next').NextConfig} */
const nextConfig = {
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
};

module.exports = nextConfig;
