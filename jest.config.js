module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  testMatch: ['**/__tests__/**/*.test.ts'],
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.d.ts',
    // SPLIT-197 §C-MCP: the OpenAPI-generated type surface is type-only (no
    // runtime code) and re-generated via `npm run gen:api`; exclude it from
    // coverage so it can't skew the ratio (mirrors the frontend).
    '!src/generated/**',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  // Ratcheted to the achieved level (SPLIT-1499). Actuals at the time of the
  // ratchet: 83.36 stmts / 73.85 branch / 73.07 funcs / 85.58 lines. Each
  // threshold sits ~2.5-3 points below its actual: low enough that an
  // unrelated PR does not fail spuriously, high enough that a real coverage
  // regression does. Raise these when coverage genuinely improves; never
  // lower one to make a red build green.
  coverageThreshold: {
    global: {
      branches: 71,
      functions: 70,
      lines: 83,
      statements: 80,
    },
  },
};
