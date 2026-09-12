// ESLint flat config (SPLIT-1450).
//
// This repo tracked no ESLint config at all — only an `.eslintignore` — and
// `npm run lint` was `next lint`. With nothing to find, `next lint` drops into
// the interactive "How would you like to configure ESLint?" prompt, so it can
// never complete in a gate: lint had never actually run here. `next lint` is
// also deprecated and removed in Next.js 16 (its own output points at the
// ESLint CLI), so package.json now calls `eslint` directly.
//
// Flat config does NOT read `.eslintignore`, so that file's one entry is ported
// into `ignores` below and the file itself is deleted — left in place it would
// read as a control that nothing consumes, which is how this repo got here.
// (The backend dropped its own `.eslintignore` the same way on migration.)
//
// Shape follows the backend's eslint.config.mjs — @typescript-eslint
// recommended as the spine, plus a short list of explicit house rules — minus
// what does not apply here: this is a single Next.js API route, not an Nx
// monorepo, and it has no Prettier and no React/JSX surface. Linting is
// deliberately NOT type-aware (no `parserOptions.project`): nothing in the
// enabled set needs type information, and `tsc --noEmit` already runs in the
// gate, so paying for a second full type-check per lint would buy nothing.
import tseslint from '@typescript-eslint/eslint-plugin';
import next from '@next/eslint-plugin-next';

export default [
  {
    ignores: [
      '**/node_modules/**',
      '.next/**',
      'coverage/**',
      // Ported from .eslintignore (SPLIT-197 §C-MCP): generated from the
      // backend OpenAPI contract via `npm run gen:api`, never hand-edited.
      'src/generated/**',
      // Next.js writes this one and stamps it "should not be edited".
      'next-env.d.ts',
    ],
  },

  // extends: plugin:@typescript-eslint/recommended (parser + plugin,
  // eslint-recommended's TS adjustments, recommended rules). Unlike the
  // backend this KEEPS `no-explicit-any` and `ban-ts-comment` on: "No `any`
  // types" and "no ts-ignore" are standing rules for this project (CLAUDE.md),
  // and src/ is already clean of both — so they are rails, not a backlog.
  ...tseslint.configs['flat/recommended'],

  // The Next.js rails. Almost all 21 target pages and components, which this
  // API-only server does not have yet; they are here so that the first page
  // added is linted like one, not because they fire today.
  next.flatConfig.recommended,

  {
    rules: {
      // Mirrors the backend's unused-vars contract, `_`-prefix escape included.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
      // The backend bans console outright because Nest gives it a Logger. This
      // server has none: `console.error` IS the Vercel serverless log, and the
      // tools use it deliberately. Stray `console.log` in a process that
      // handles bearer tokens is a different matter, so only warn/error pass.
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },

  // Tests drive the route through hand-built Web `Request` objects and stub
  // transports, which legitimately needs casts and `require`-style mocks that
  // production code must never use. Everything else still applies.
  {
    files: ['__tests__/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },

  // Build tooling at the repo root is CommonJS, not ESM/TypeScript.
  {
    files: ['*.js'],
    languageOptions: { sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
];
