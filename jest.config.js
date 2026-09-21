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
  // Ratcheted to the achieved level (SPLIT-1499, re-ratcheted when the MCP 2.0
  // OAuth + tool-registry work landed and raised coverage across the board).
  // Actuals at the time of this ratchet: 90.31 stmts / 79.67 branch /
  // 82.22 funcs / 92.42 lines, over 527 tests in 37 suites. Each threshold
  // sits ~2.5-3 points below its actual: low enough that an unrelated PR does
  // not fail spuriously, high enough that a real coverage regression does.
  // Raise these when coverage genuinely improves; never lower one to make a
  // red build green.
  coverageThreshold: {
    global: {
      branches: 77,
      functions: 79,
      lines: 90,
      statements: 87,
    },
  },
};
