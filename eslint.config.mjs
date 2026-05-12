import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['cdk.out/**', 'node_modules/**', '**/*.d.ts', '**/*.js'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
);
