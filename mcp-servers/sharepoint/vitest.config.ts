import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      // Floors below intentionally trail the actual measurement by ~1 pp so
      // CI never auto-loosens on accidental regressions, yet does not block
      // on the two stubborn paths in `client.ts`: the race-condition retry
      // inside `callGraphAPI` (mid-401 token-rotation by another caller)
      // and `debugLog(msg, data)` (gated by `process.env.DEBUG` AND the
      // two-arg overload — only `createRemoteFolder` hits the two-arg form
      // and only when JSON parse throws, so the combinatoric test surface
      // would dwarf the line coverage gained).
      //
      // Actual values at landing (commit fdca21 / PR #671):
      //   stmts 99.1%   funcs 98.5%   lines 99.4%   branches 94.1%
      thresholds: {
        lines: 98,
        functions: 98,
        branches: 90,
        statements: 98,
      },
    },
  },
});
