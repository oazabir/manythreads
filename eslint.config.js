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
