export default {
  extends: ['stylelint-config-standard'],
  ignoreFiles: ['**/node_modules/**', '**/dist/**', '**/coverage/**', 'docs/spec/**', '**/playwright-report/**', '**/test-results/**'],
  rules: {
    'color-no-hex': true,
    'selector-class-pattern': null,
    'custom-property-pattern': null,
  },
  overrides: [
    { files: ['clients/web/src/styles/tokens.css'], rules: { 'color-no-hex': null } },
  ],
};
