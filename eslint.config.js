import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

const BANNED_SUFFIX = '/(Dto|Model|ViewModel)$/';
const bannedNameMsg = 'Names ending in Dto/Model/ViewModel are banned (D1: use the shared Zod type name).';
const nameBans = [
  `TSTypeAliasDeclaration[id.name=${BANNED_SUFFIX}]`,
  `TSInterfaceDeclaration[id.name=${BANNED_SUFFIX}]`,
  `ClassDeclaration[id.name=${BANNED_SUFFIX}]`,
  `VariableDeclarator[id.name=${BANNED_SUFFIX}]`,
].map((selector) => ({ selector, message: bannedNameMsg }));

const hexRe = '/#[0-9a-fA-F]{3,8}\\b/';
const hexMsg = 'Raw hex colours are banned outside packages/shared/src/tokens.ts; use design tokens.';
const hexBans = [
  { selector: `Literal[value=${hexRe}]`, message: hexMsg },
  { selector: `TemplateElement[value.raw=${hexRe}]`, message: hexMsg },
];

const poolBan = {
  selector: "CallExpression[callee.type='MemberExpression'][callee.object.name='pool'][callee.property.name='query']",
  message: 'No bare pool.query outside packages/kernel/src/db/; use withActor/withSystem.',
};

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      'docs/spec/**',
      '**/playwright-report/**',
      '**/test-results/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,js,mjs}'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      'no-restricted-syntax': ['error', ...nameBans, ...hexBans, poolBan],
    },
  },
  {
    // A promise nobody awaits is a write that may land after its caller returned, or never (MISTAKES: un-awaited `ctx.audit.emit`).
    // Type-aware, so server code only (tests drive timing on purpose and are not linted with it).
    files: ['packages/**/src/**/*.ts'],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: { '@typescript-eslint/no-floating-promises': 'error' },
  },
  {
    // The diagram frame's script is plain browser JavaScript served as is (no build step), written in the older `var` style.
    files: ['clients/web/public/*.js'],
    languageOptions: { globals: { ...globals.browser, mermaid: 'readonly' } },
    rules: { 'no-useless-escape': 'off', '@typescript-eslint/no-unused-vars': ['error', { caughtErrors: 'none' }] },
  },
  {
    files: ['clients/web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  {
    files: ['packages/shared/src/tokens.ts'],
    rules: { 'no-restricted-syntax': ['error', ...nameBans, poolBan] },
  },
  {
    files: ['packages/kernel/src/db/**'],
    rules: { 'no-restricted-syntax': ['error', ...nameBans, ...hexBans] },
  },
);
