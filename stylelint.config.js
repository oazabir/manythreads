export default {
  extends: ['stylelint-config-standard'],
  ignoreFiles: ['.claude/**', 'data/**', '**/node_modules/**', '**/dist/**', '**/dist-canary/**', '**/coverage/**', 'docs/spec/**', 'clients/desktop/src-tauri/target/**', 'clients/desktop/src-tauri/gen/**', '**/playwright-report/**', '**/test-results/**'],
  rules: {
    'color-no-hex': true,
    // P21-21: a colour is a token. rgb() and hsl() are written in tokens.css only, and a dark colour comes from a token, never from a per-screen `[data-theme]` rule
    'function-disallowed-list': ['rgb', 'rgba', 'hsl', 'hsla'],
    'selector-disallowed-list': [/data-theme/],
    'selector-class-pattern': null,
    'custom-property-pattern': null,
    // P21-20: screens use the look tokens (radius, type size, colour meaning) and never remove the focus ring
    'declaration-property-value-allowed-list': {
      'border-radius': [/^(0|50%|inherit|var\(--radius-(xs|sm|md|lg|pill)\))( (0|50%|var\(--radius-(xs|sm|md|lg|pill)\))){0,3}$/],
      'font-size': [/^var\(--fs-[a-z0-9]+\)$/, 'inherit', /^[\d.]+(em|%)$/],
    },
    'declaration-property-value-disallowed-list': { outline: ['none', '0'] },
  },
  overrides: [
    // the desktop app's first-run server picker is a page of its own (system colours and sizes), it does not load the web tokens
    { files: ['clients/desktop/ui/picker.css'], rules: { 'declaration-property-value-allowed-list': null } },
    { files: ['clients/web/src/styles/tokens.css'], rules: { 'declaration-property-value-allowed-list': null } },
    // P28-01: tokens.css and the generated palette files (themes/<id>.css) are the only places for raw colours and for a `data-theme` selector
    { files: ['clients/web/src/styles/tokens.css', 'clients/web/src/styles/themes/*.css'], rules: { 'color-no-hex': null, 'function-disallowed-list': null, 'selector-disallowed-list': null, 'declaration-property-value-allowed-list': null } },
  ],
};
