import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const tsRules = {
  files: ['src/**/*.{ts,tsx}'],
  languageOptions: {
    parserOptions: {
      project: './tsconfig.json',
      tsconfigRootDir: process.cwd(),
      sourceType: 'module',
    },
  },
  rules: {
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
    '@typescript-eslint/consistent-type-imports': 'error',
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/no-require-imports': 'off',
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/require-await': 'off',
  },
};

export default tseslint.config(
  { ignores: ['node_modules', 'dist', 'client/dist', 'client/node_modules', '.pnpm', '.pnpm-store'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  tsRules,
  {
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      '@typescript-eslint/no-misused-promises': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  }
);
