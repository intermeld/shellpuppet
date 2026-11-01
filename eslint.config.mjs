// ESLint flat config. The scoped no-console / no-process-stream rules below are a
// design requirement (design §2.4): the MCP adapter speaks its protocol over stdout,
// so nothing in core/ or client/ may ever write to stdout or stderr. Logging in those
// modules goes through the injected Logger only.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/',
      'coverage/',
      'node_modules/',
      // Documentation: no code to lint.
      'docs/',
      // Standalone sink programs spawned BY the integration tests, not part of
      // the project's module graph: they run as bare node scripts and their
      // whole job is emitting raw control characters, which the project rules
      // (rightly) forbid in library code.
      'test/fixtures/',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // stdout discipline (design §2.4): a hard rule, scoped to the modules the MCP
    // adapter loads in-process.
    files: ['src/core/**/*.ts', 'src/client/**/*.ts'],
    rules: {
      'no-console': 'error',
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'stdout',
          message:
            'core/ and client/ must never touch stdout: it carries the MCP stdio protocol. Use the injected Logger.',
        },
        {
          object: 'process',
          property: 'stderr',
          message:
            'core/ and client/ must never touch stderr. Use the injected Logger.',
        },
      ],
    },
  },
  {
    files: ['**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // The viewer is plain browser JavaScript served as-is, with no type
    // information, browser globals instead of Node's. languageOptions must
    // MERGE with disableTypeChecked's, which switches the project service off.
    files: ['src/viewer/**/*.js'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: {
        document: 'readonly',
        window: 'readonly',
        location: 'readonly',
        history: 'readonly',
        WebSocket: 'readonly',
        URLSearchParams: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        fetch: 'readonly',
        navigator: 'readonly',
        BroadcastChannel: 'readonly',
      },
    },
  },
);
