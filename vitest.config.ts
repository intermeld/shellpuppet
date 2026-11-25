import { defineConfig } from 'vitest/config';

// DevTools and page waits expired while these files overlapped other browser
// suites on CI. Give each file the runner for its capture and cleanup.
const isolatedCaptures = ['dashboard-auto-fit', 'dashboard-geometry', 'dashboard-name-page', 'viewer-notice-occupancy']
  .map(name => `test/integration/${name}.test.ts`);
const capturePass = process.env['SP_CI_CAPTURE_PASS'];

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/core/**'],
      reporter: ['text', 'html'],
      // Design/AGENTS.md target: >80% on core/.
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
    projects: [
      {
        test: {
          name: 'unit',
          // test/daemon and test/mcp hold unit tests for PURE logic on the
          // daemon and adapter sides (config shape validation); anything that
          // binds ports or spawns PTYs belongs to the integration project.
          include: ['test/core/**/*.test.ts', 'test/daemon/**/*.test.ts', 'test/mcp/**/*.test.ts'],
          // A pattern's time budget is wall-clock, so the suite gives
          // patterns more of it than the product does (the file says why).
          setupFiles: ['./test/regex-budget-setup.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: capturePass === 'isolated' ? isolatedCaptures : ['test/integration/**/*.test.ts'],
          ...(capturePass === 'remaining' ? { exclude: isolatedCaptures } : {}),
          // Builds dist/ first: the lifecycle tests spawn the real compiled
          // daemon as a detached subprocess.
          globalSetup: ['./test/integration/global-setup.ts'],
          // In-process daemons evaluate patterns too. Daemons the tests start
          // from dist/ keep the product's budget.
          setupFiles: ['./test/regex-budget-setup.ts'],
          // Real PTYs and real process spawns: Windows CI needs generosity.
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
