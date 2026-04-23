/**
 * ESLint config for apps/backend.
 *
 * Primary goal: catch scope errors like the `job is not defined`
 * ReferenceError in `handleFullRebuild` that the test suite missed
 * (commit `df39559` + the subsequent fix in `4d1df60`). The backend
 * had no lint configured at all until this file was added.
 *
 * Scope: runtime-correctness rules only. No style opinions — those
 * are out of scope for the short term and would create too much
 * churn on a working codebase. If we want Prettier / style
 * enforcement later, add it as a separate config layer.
 *
 * Matches the flat-config style used by `apps/web/eslint.config.js`.
 */

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['coverage/**', 'prisma/generated/**'] },

  // All production source files (CommonJS Node.js)
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      // `no-unused-vars` in recommended defaults to error — dial it down
      // to warn and allow leading-underscore idioms that are common in
      // this codebase (destructure-to-discard, catch blocks, etc.).
      'no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // Keep no-undef at error — this is the whole reason we're
      // introducing lint. It catches references to undeclared
      // identifiers (scope bugs, typos, missing requires).
      'no-undef': 'error',
    },
  },

  // Jest test files get the jest globals
  {
    files: ['src/__tests__/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
  },
];
