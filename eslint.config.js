import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // docs/decisions/data/ holds evidence kept as it was run, such as probe scripts, like Prettier.
  {
    ignores: [
      'dist/',
      'demo/dist/',
      'test-results/',
      'playwright-report/',
      'coverage/',
      'node_modules/',
      'docs/decisions/data/',
      'reports/',
      '.stryker-tmp/',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['*.js', '*.mjs', 'scripts/*.js'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
    },
  },
  {
    // Algorithms take an injected Clock so tests can control time.
    files: ['src/algorithms/**/*.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'Date', property: 'now', message: 'Use the injected Clock instead.' },
      ],
    },
  },
  {
    // The demo's React code: the rules of hooks, and effects that list what they depend on.
    files: ['demo/**/*.tsx'],
    ...reactHooks.configs.flat.recommended,
  },
  {
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
