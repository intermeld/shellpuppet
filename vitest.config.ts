import { defineConfig } from 'vitest/config';

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
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          // Builds dist/ first: the lifecycle tests spawn the real compiled
          // daemon as a detached subprocess.
          globalSetup: ['./test/integration/global-setup.ts'],
          // Real PTYs and real process spawns: Windows CI needs generosity.
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
