module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  testMatch: ['**/__tests__/**/*.ts', '**/*.test.ts', '**/*.spec.ts'],
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
  coverageThreshold: {
    global: {
      branches: 30,
      functions: 30,
      lines: 30,
      statements: 30,
    },
  },
};
