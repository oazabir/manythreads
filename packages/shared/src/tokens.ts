/** Design tokens mirrored from clients/web/src/styles/tokens.css. The only module (with that CSS) allowed raw hex. */
export const tokens = {
  paper: '#EDEEF0',
  surface: '#FFFFFF',
  shell: '#F3F4F6',
  ink: '#1B2430',
  mute: '#5A6472',
  faint: '#8A929C',
  rule: '#D4D8DE',
  human: '#2E5C8A',
  agent: '#7B5EA7',
  agentWash: '#FBF9FE',
  ok: '#3F7D58',
  warn: '#B08A3E',
  alert: '#B4472E',
  alertWash: '#FDF6F3',
  fonts: { sans: 'Inter Tight', mono: 'JetBrains Mono' },
} as const;

export type Tokens = typeof tokens;
export type ColorTokenName = Exclude<keyof Tokens, 'fonts'>;

/** Token name -> CSS custom property name. */
export const tokenCssVar = {
  paper: '--paper',
  surface: '--surface',
  shell: '--shell',
  ink: '--ink',
  mute: '--mute',
  faint: '--faint',
  rule: '--rule',
  human: '--human',
  agent: '--agent',
  agentWash: '--agent-wash',
  ok: '--ok',
  warn: '--warn',
  alert: '--alert',
  alertWash: '--alert-wash',
  fonts: { sans: '--sans', mono: '--mono' },
} as const satisfies Record<keyof Tokens, string | Record<string, string>>;
