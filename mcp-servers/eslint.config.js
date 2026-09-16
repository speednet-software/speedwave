// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import jsdoc from 'eslint-plugin-jsdoc';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/wasm-pkg/**',
      '**/*.js',
      '**/*.cjs',
      '**/*.mjs',
      '**/coverage/**',
      '**/*.test.ts',
    ],
  },

  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  jsdoc.configs['flat/recommended-typescript'],
  eslintPluginPrettierRecommended,

  {
    files: ['**/src/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-console': 'off',

      'jsdoc/require-jsdoc': [
        'error',
        {
          publicOnly: true,
          require: {
            FunctionDeclaration: true,
            MethodDefinition: true,
            ClassDeclaration: true,
            ArrowFunctionExpression: false,
            FunctionExpression: false,
          },
          contexts: [
            'ExportNamedDeclaration > FunctionDeclaration',
            'ExportNamedDeclaration > VariableDeclaration > VariableDeclarator > ArrowFunctionExpression',
            'TSInterfaceDeclaration',
            'TSTypeAliasDeclaration',
          ],
        },
      ],
      'jsdoc/require-description': ['error', { contexts: ['any'] }],
      'jsdoc/require-param-description': 'error',
      'jsdoc/require-returns-description': 'error',
      'jsdoc/check-param-names': 'error',
      'jsdoc/check-tag-names': ['error', { definedTags: ['interface', 'property', 'future'] }],
      'jsdoc/check-types': 'off',
      'jsdoc/require-param-type': 'off',
      'jsdoc/require-returns-type': 'off',
      'jsdoc/require-property-description': 'error',
      'jsdoc/no-types': 'off',
      'jsdoc/no-defaults': 'off',
      'jsdoc/require-returns': 'off',

      'jsdoc/require-param': 'error',
      'jsdoc/escape-inline-tags': 'error',
    },
  }
);
