// ESLint 9 flat config for the August Proxy desktop frontend.
// Enforces:
//   - no-explicit-any: warn (start), will escalate to error after Phase 2
//   - consistent-type-assertions: 'as' style
//   - React Hooks rules
//   - type-checked rules where reasonable
//
// Run with: `npm run lint`

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'web-dist/**',
      'src-tauri/**',
      'vite.config.js.timestamp-*',
      'vite.config.d.ts',
      'vite.config.js',
      'eslint.config.js',
      'postcss.config.js',
      'tailwind.config.cjs',
      'coverage/**',
      '**/__pycache__/**',
    ],
  },

  // Base recommended JS rules — apply to .js and .ts
  js.configs.recommended,

  // Type-checked rules — ONLY for files in src/ that are part of the
  // main tsconfig (so type info is available). Other files (.js configs,
  // vite.config.ts in tsconfig.node.json) skip these rules entirely.
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.es2022,
      },
      parserOptions: {
        project: ['./tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      // Phase 0 starts as warn; Phase 2 escalates to error.
      '@typescript-eslint/no-explicit-any': 'warn',

      // Surface unsafe uses of typed slots.
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',

      // Prefer `as Foo` over `<Foo>value`.
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        { assertionStyle: 'as' },
      ],

      // React Hooks rules
      ...reactHooks.configs.recommended.rules,

      // Allow unused vars prefixed with underscore
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // Acceptable relaxation: namespace conventions vary in this codebase
      '@typescript-eslint/no-namespace': 'off',
      '@typescript-eslint/triple-slash-reference': 'off',

      // React Refresh (HMR) — only require for entry components; we let it warn
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
    },
  },

  // Tests can be looser — they often need to cast mocks.
  {
    files: [
      'src/**/__tests__/**/*.{ts,tsx}',
      'src/**/*.test.{ts,tsx}',
      'src/test/**/*.{ts,tsx}',
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
    },
  },
);