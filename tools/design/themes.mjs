// P28-01: the three themes as data. `tools/design/build-themes.mjs` turns this into clients/web/src/styles/themes/<id>.css; a test fails when the two differ.
// Every key of a palette is a custom property name without the leading "--". Names that exist in clients/web/src/styles/tokens.css keep their name.
// The contrast of every pair is checked on the generated CSS by tools/lint-contrast, not here. Design and reasons: docs/design/themes.md.

// ---- oklch -> sRGB hex (used for the ten avatar tones only) ----
function oklch(L, C, h) {
  const a = C * Math.cos((h * Math.PI) / 180), b = C * Math.sin((h * Math.PI) / 180);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b, m_ = L - 0.1055613458 * a - 0.0638541728 * b, s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  const lin = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  return '#' + lin.map((v) => {
    const c = Math.min(1, Math.max(0, v));
    const g = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
    return Math.round(g * 255).toString(16).padStart(2, '0');
  }).join('').toUpperCase();
}

// blue, violet, green, ochre, coral, teal, plum, olive, amber-brown, neutral: the same ten meanings as today
const AV_HUES = [250, 300, 155, 85, 35, 205, 335, 120, 60, null];
function avatars(mode, chroma, neutralHue) {
  const out = {};
  AV_HUES.forEach((h, i) => {
    const n = i + 1;
    const hue = h ?? neutralHue, c = h === null ? 0.012 : chroma;
    if (mode === 'light') {
      out[`av-${n}-bg`] = oklch(0.915, c * 0.55, hue);
      out[`av-${n}-ink`] = oklch(0.38, c * 1.25, hue);
    } else {
      out[`av-${n}-bg`] = oklch(0.31, c * 0.6, hue);
      out[`av-${n}-ink`] = oklch(0.86, c * 1.1, hue);
    }
  });
  return out;
}

const lightFixed = { plate: '#FFFFFF', 'on-color': '#FFFFFF', 'on-color-line': 'rgb(255 255 255 / 35%)' };

export const THEMES = [
  {
    id: 'graphite',
    name: 'Graphite',
    mood: 'Calm and exact: neutral greys, hairline borders, almost no shadow, colour only where something is happening.',
    look: {
      sans: '"Inter", system-ui, sans-serif', 'font-display': '"Inter", system-ui, sans-serif', mono: '"JetBrains Mono", ui-monospace, monospace',
      'font-features': 'normal',
      'fs-display': '26px', 'fs-h1': '20px', 'fs-h2': '15px', 'fs-body': '14px', 'lh-body': '1.5', 'fs-small': '13px', 'fs-caption': '12px', 'fs-tiny': '11px',
      'fw-title': '600', 'fw-caption': '500', 'fw-display': '600', 'ls-title': '-0.014em', 'ls-body': '-0.006em', 'ls-caps': '0.04em',
      'radius-xs': '4px', 'radius-sm': '6px', 'radius-md': '8px', 'radius-lg': '12px', 'radius-pill': '999px',
      'ctl-h': '30px', 'ctl-pad-x': '10px', 'sp-1': '4px', 'sp-2': '8px', 'sp-3': '12px', 'sp-4': '16px', 'sp-5': '24px', 'sp-6': '32px',
      'row-h': '28px', 'msg-pad-y': '5px', 'msg-gap': '4px', 'run-gap': '4px', 'av-size': '30px', 'gutter-w': '32px',
      'dur-fast': '80ms', 'dur-menu': '110ms', 'dur-panel': '180ms', 'dur-pulse': '1.6s', 'ease-out': 'cubic-bezier(0.2, 0.7, 0.3, 1)',
      'run-rail-w': '0px', 'border-w': '1px',
    },
    light: {
      paper: '#F0F1F3', surface: '#FFFFFF', shell: '#F7F7F8', ink: '#17181C', txt: '#26282E', mute: '#5B606B', faint: '#7B808B', rule: '#DFE1E5',
      hairline: '#ECEDF0', 'table-head': '#FAFAFB', 'nav-on': '#E8E9EC', 'msg-hover': '#F6F6F8',
      human: '#3156C4', 'human-wash': '#EEF2FC', 'human-border': '#BDCBF0',
      agent: '#7450C2', 'agent-wash': '#F5F2FC', 'agent-border': '#D7CCF0', 'agent-ink': '#4C3190',
      ok: '#2B7A52', 'ok-wash': '#EDF6F1', 'ok-border': '#B5D8C4', 'ok-ink': '#1E5C3D',
      warn: '#9F7416', 'warn-wash': '#FBF6E8', 'warn-border': '#E5D2A0', 'warn-ink': '#6E500E',
      alert: '#C2412C', 'alert-wash': '#FDF3F1', 'alert-border': '#ECBEB4', 'alert-ink': '#8E2E1D',
      'bot-grey': '#646A76', zip: '#8A5A2B', 'dot-off': '#C4C7CE', 'presence-ring': '#787D88', 'toggle-off': '#C9CCD3',
      ...lightFixed, 'shadow-color': '23 24 28', 'card-alpha': '5%', 'menu-alpha': '12%', 'savebar-alpha': '20%', 'scrim-alpha': '38%',
      hover: 'rgb(23 24 28 / 5%)', skeleton: '#E7E8EC', 'skeleton-hi': '#F3F4F6',
      // new
      accent: '#17181C', 'accent-hover': '#2C2E35', 'on-accent': '#FFFFFF', 'control-border': '#8A8F9A', 'control-bg': '#FFFFFF', 'focus-ring': '#3156C4',
      'code-bg': '#F5F5F7', 'code-border': '#E3E5E9', 'code-ink': '#26282E', selection: '#D5DFFA',
      'run-bg': '#FBFBFC', 'run-border': '#DFE1E5', 'run-rail': '#7450C2', 'run-state-ink': '#4C3190', 'run-pulse': '#7450C2',
      'todo-bg': '#FFFFFF', 'todo-border': '#DFE1E5', 'todo-track': '#E8E9EC', 'todo-fill': '#2B7A52',
      'elev-1': '0 0 0 0 transparent', 'elev-2': '0 4px 16px rgb(23 24 28 / 10%), 0 0 0 1px rgb(23 24 28 / 4%)', 'elev-3': '0 16px 40px rgb(23 24 28 / 16%), 0 0 0 1px rgb(23 24 28 / 5%)',
      ...avatars('light', 0.075, 265),
    },
    dark: {
      paper: '#08090A', surface: '#111214', shell: '#0C0D0F', ink: '#EDEEF0', txt: '#D5D7DB', mute: '#9A9FA9', faint: '#70757F', rule: '#26282D',
      hairline: '#1B1D21', 'table-head': '#15171A', 'nav-on': '#1E2024', 'msg-hover': '#17181B',
      human: '#8EA7F4', 'human-wash': '#161D33', 'human-border': '#2E3F73',
      agent: '#B49BEF', 'agent-wash': '#1C172B', 'agent-border': '#40346A', 'agent-ink': '#CDBBF6',
      ok: '#5DBB8A', 'ok-wash': '#11231A', 'ok-border': '#27543C', 'ok-ink': '#8AD3AB',
      warn: '#D6AB58', 'warn-wash': '#262012', 'warn-border': '#574722', 'warn-ink': '#E5C583',
      alert: '#EF8670', 'alert-wash': '#2A1815', 'alert-border': '#66362C', 'alert-ink': '#F5A794',
      'bot-grey': '#8A909B', zip: '#D69E6C', 'dot-off': '#454850', 'presence-ring': '#8A909B', 'toggle-off': '#3A3D44',
      ...lightFixed, 'shadow-color': '0 0 0', 'card-alpha': '40%', 'menu-alpha': '55%', 'savebar-alpha': '70%', 'scrim-alpha': '62%',
      hover: 'rgb(255 255 255 / 6%)', skeleton: '#1E2024', 'skeleton-hi': '#292B31',
      accent: '#EDEEF0', 'accent-hover': '#FFFFFF', 'on-accent': '#111214', 'control-border': '#6A6F79', 'control-bg': '#0C0D0F', 'focus-ring': '#8EA7F4',
      'code-bg': '#0C0D0F', 'code-border': '#26282D', 'code-ink': '#D5D7DB', selection: '#263562',
      'run-bg': '#141518', 'run-border': '#26282D', 'run-rail': '#B49BEF', 'run-state-ink': '#CDBBF6', 'run-pulse': '#B49BEF',
      'todo-bg': '#141518', 'todo-border': '#26282D', 'todo-track': '#26282D', 'todo-fill': '#5DBB8A',
      'elev-1': '0 0 0 0 transparent', 'elev-2': '0 6px 20px rgb(0 0 0 / 50%), 0 0 0 1px rgb(255 255 255 / 6%)', 'elev-3': '0 20px 48px rgb(0 0 0 / 60%), 0 0 0 1px rgb(255 255 255 / 7%)',
      ...avatars('dark', 0.075, 265),
    },
  },
  {
    id: 'linen',
    name: 'Linen',
    mood: 'Warm and unhurried: paper tones, a serif for titles, soft shadows; reads like a well-kept notebook.',
    look: {
      sans: '"IBM Plex Sans", system-ui, sans-serif', 'font-display': '"Source Serif 4", Georgia, serif', mono: '"IBM Plex Mono", ui-monospace, monospace',
      'font-features': 'normal',
      'fs-display': '32px', 'fs-h1': '24px', 'fs-h2': '17px', 'fs-body': '15px', 'lh-body': '1.6', 'fs-small': '13.5px', 'fs-caption': '12.5px', 'fs-tiny': '11.5px',
      'fw-title': '600', 'fw-caption': '500', 'fw-display': '600', 'ls-title': '-0.012em', 'ls-body': '0', 'ls-caps': '0.05em',
      'radius-xs': '5px', 'radius-sm': '8px', 'radius-md': '12px', 'radius-lg': '18px', 'radius-pill': '999px',
      'ctl-h': '34px', 'ctl-pad-x': '12px', 'sp-1': '4px', 'sp-2': '8px', 'sp-3': '14px', 'sp-4': '20px', 'sp-5': '28px', 'sp-6': '40px',
      'row-h': '32px', 'msg-pad-y': '8px', 'msg-gap': '6px', 'run-gap': '6px', 'av-size': '34px', 'gutter-w': '36px',
      'dur-fast': '120ms', 'dur-menu': '160ms', 'dur-panel': '240ms', 'dur-pulse': '2s', 'ease-out': 'cubic-bezier(0.22, 0.8, 0.3, 1)',
      'run-rail-w': '0px', 'border-w': '1px',
    },
    light: {
      paper: '#EDE7DD', surface: '#FCFAF6', shell: '#F4EFE7', ink: '#2C2420', txt: '#3A312C', mute: '#65594F', faint: '#85786C', rule: '#DDD4C6',
      hairline: '#EAE3D8', 'table-head': '#F7F3EC', 'nav-on': '#E6DED1', 'msg-hover': '#F6F2EA',
      human: '#2A5A85', 'human-wash': '#EBF1F5', 'human-border': '#B4C9D9',
      agent: '#80488C', 'agent-wash': '#F7F0F6', 'agent-border': '#DEC8E0', 'agent-ink': '#5B2F66',
      ok: '#3F7140', 'ok-wash': '#EEF4EA', 'ok-border': '#BFD5B8', 'ok-ink': '#2D5730',
      warn: '#9A6B14', 'warn-wash': '#FAF2DF', 'warn-border': '#E4CF9B', 'warn-ink': '#6C4A0C',
      alert: '#B23F28', 'alert-wash': '#FBEFEA', 'alert-border': '#E6BBAD', 'alert-ink': '#84301D',
      'bot-grey': '#6E6258', zip: '#8A5A2B', 'dot-off': '#CBC1B3', 'presence-ring': '#85786C', 'toggle-off': '#CFC5B7',
      ...lightFixed, 'shadow-color': '70 50 30', 'card-alpha': '8%', 'menu-alpha': '16%', 'savebar-alpha': '24%', 'scrim-alpha': '36%',
      hover: 'rgb(70 50 30 / 6%)', skeleton: '#E6DED1', 'skeleton-hi': '#F2ECE2',
      accent: '#3A2D26', 'accent-hover': '#4D3D34', 'on-accent': '#FCFAF6', 'control-border': '#94877A', 'control-bg': '#FFFEFB', 'focus-ring': '#2A5A85',
      'code-bg': '#F4EFE7', 'code-border': '#E2D9CB', 'code-ink': '#3A312C', selection: '#D9E4EC',
      'run-bg': '#F7F0F6', 'run-border': '#DEC8E0', 'run-rail': '#80488C', 'run-state-ink': '#5B2F66', 'run-pulse': '#80488C',
      'todo-bg': '#FFFEFB', 'todo-border': '#DDD4C6', 'todo-track': '#E6DED1', 'todo-fill': '#3F7140',
      'elev-1': '0 1px 2px rgb(70 50 30 / 6%), 0 2px 8px rgb(70 50 30 / 5%)', 'elev-2': '0 2px 4px rgb(70 50 30 / 6%), 0 10px 28px rgb(70 50 30 / 14%)', 'elev-3': '0 4px 8px rgb(70 50 30 / 8%), 0 24px 56px rgb(70 50 30 / 20%)',
      ...avatars('light', 0.06, 60),
    },
    dark: {
      paper: '#161311', surface: '#211D1A', shell: '#1B1815', ink: '#F0E9E0', txt: '#DDD4C9', mute: '#B3A699', faint: '#877B6F', rule: '#3B342E',
      hairline: '#2D2824', 'table-head': '#26221E', 'nav-on': '#352E29', 'msg-hover': '#282320',
      human: '#92BBDC', 'human-wash': '#1C2933', 'human-border': '#375369',
      agent: '#D2A6DC', 'agent-wash': '#2B2030', 'agent-border': '#59405F', 'agent-ink': '#E3C3EA',
      ok: '#93C48C', 'ok-wash': '#1D2A1C', 'ok-border': '#3D5A3A', 'ok-ink': '#B1D9AB',
      warn: '#DDB265', 'warn-wash': '#2E2615', 'warn-border': '#5F4D25', 'warn-ink': '#EBCB8C',
      alert: '#EE9077', 'alert-wash': '#331D17', 'alert-border': '#6F3C30', 'alert-ink': '#F6AE9A',
      'bot-grey': '#A09385', zip: '#DDA774', 'dot-off': '#544B43', 'presence-ring': '#A09385', 'toggle-off': '#4A423B',
      ...lightFixed, 'shadow-color': '0 0 0', 'card-alpha': '36%', 'menu-alpha': '50%', 'savebar-alpha': '66%', 'scrim-alpha': '60%',
      hover: 'rgb(255 240 220 / 7%)', skeleton: '#2D2824', 'skeleton-hi': '#3B342E',
      accent: '#F0E9E0', 'accent-hover': '#FFFAF2', 'on-accent': '#211D1A', 'control-border': '#8B7F73', 'control-bg': '#1B1815', 'focus-ring': '#92BBDC',
      'code-bg': '#1B1815', 'code-border': '#3B342E', 'code-ink': '#DDD4C9', selection: '#2F4758',
      'run-bg': '#2B2030', 'run-border': '#59405F', 'run-rail': '#D2A6DC', 'run-state-ink': '#E3C3EA', 'run-pulse': '#D2A6DC',
      'todo-bg': '#26221E', 'todo-border': '#3B342E', 'todo-track': '#3B342E', 'todo-fill': '#93C48C',
      'elev-1': '0 1px 2px rgb(0 0 0 / 30%), 0 2px 10px rgb(0 0 0 / 22%)', 'elev-2': '0 2px 6px rgb(0 0 0 / 35%), 0 12px 32px rgb(0 0 0 / 45%)', 'elev-3': '0 4px 10px rgb(0 0 0 / 40%), 0 28px 64px rgb(0 0 0 / 55%)',
      ...avatars('dark', 0.06, 60),
    },
  },
  {
    id: 'harbor',
    name: 'Harbor',
    mood: 'Clear and confident: white panels on cool blue-grey, one strong blue for what you can press, crisp edges.',
    look: {
      sans: '"Geist", system-ui, sans-serif', 'font-display': '"Geist", system-ui, sans-serif', mono: '"Geist Mono", ui-monospace, monospace',
      'font-features': 'normal',
      'fs-display': '28px', 'fs-h1': '22px', 'fs-h2': '16px', 'fs-body': '14.5px', 'lh-body': '1.5', 'fs-small': '13px', 'fs-caption': '12px', 'fs-tiny': '11px',
      'fw-title': '600', 'fw-caption': '500', 'fw-display': '600', 'ls-title': '-0.02em', 'ls-body': '0.008em', 'ls-caps': '0.06em',
      'radius-xs': '4px', 'radius-sm': '6px', 'radius-md': '10px', 'radius-lg': '14px', 'radius-pill': '999px',
      'ctl-h': '32px', 'ctl-pad-x': '12px', 'sp-1': '4px', 'sp-2': '8px', 'sp-3': '12px', 'sp-4': '16px', 'sp-5': '24px', 'sp-6': '32px',
      'row-h': '30px', 'msg-pad-y': '6px', 'msg-gap': '6px', 'run-gap': '4px', 'av-size': '32px', 'gutter-w': '34px',
      'dur-fast': '100ms', 'dur-menu': '130ms', 'dur-panel': '200ms', 'dur-pulse': '1.4s', 'ease-out': 'cubic-bezier(0.16, 1, 0.3, 1)',
      'run-rail-w': '3px', 'border-w': '1px',
    },
    light: {
      paper: '#E9EEF4', surface: '#FFFFFF', shell: '#F3F6FA', ink: '#0F1B2D', txt: '#1E2B3E', mute: '#4F5D72', faint: '#72809A', rule: '#D5DDE8',
      hairline: '#E6EBF2', 'table-head': '#F7F9FC', 'nav-on': '#DEE6F0', 'msg-hover': '#F4F7FB',
      human: '#0B5CBF', 'human-wash': '#E8F1FC', 'human-border': '#A9C8EE',
      agent: '#6D45C9', 'agent-wash': '#F3EFFD', 'agent-border': '#CFC1F2', 'agent-ink': '#4A2A9A',
      ok: '#0F7A4B', 'ok-wash': '#E7F6EE', 'ok-border': '#A6D9BE', 'ok-ink': '#0A5C38',
      warn: '#A46A04', 'warn-wash': '#FDF4E0', 'warn-border': '#EDD195', 'warn-ink': '#744A02',
      alert: '#CC3327', 'alert-wash': '#FEF1EF', 'alert-border': '#F2B9B2', 'alert-ink': '#962018',
      'bot-grey': '#596780', zip: '#8A5A2B', 'dot-off': '#BCC6D4', 'presence-ring': '#72809A', 'toggle-off': '#C2CCDA',
      ...lightFixed, 'shadow-color': '15 27 45', 'card-alpha': '7%', 'menu-alpha': '14%', 'savebar-alpha': '22%', 'scrim-alpha': '42%',
      hover: 'rgb(15 27 45 / 5%)', skeleton: '#E1E7EF', 'skeleton-hi': '#F0F3F8',
      accent: '#0B5CBF', 'accent-hover': '#094FA6', 'on-accent': '#FFFFFF', 'control-border': '#7C8AA1', 'control-bg': '#FFFFFF', 'focus-ring': '#0B5CBF',
      'code-bg': '#F3F6FA', 'code-border': '#D5DDE8', 'code-ink': '#1E2B3E', selection: '#CCE0FA',
      'run-bg': '#FFFFFF', 'run-border': '#D5DDE8', 'run-rail': '#6D45C9', 'run-state-ink': '#4A2A9A', 'run-pulse': '#6D45C9',
      'todo-bg': '#FFFFFF', 'todo-border': '#D5DDE8', 'todo-track': '#DEE6F0', 'todo-fill': '#0F7A4B',
      'elev-1': '0 1px 2px rgb(15 27 45 / 7%)', 'elev-2': '0 1px 2px rgb(15 27 45 / 6%), 0 8px 24px rgb(15 27 45 / 13%)', 'elev-3': '0 2px 4px rgb(15 27 45 / 8%), 0 20px 48px rgb(15 27 45 / 20%)',
      ...avatars('light', 0.09, 250),
    },
    dark: {
      paper: '#070C14', surface: '#101826', shell: '#0B121D', ink: '#EAF0F8', txt: '#D2DBE8', mute: '#98A6BA', faint: '#6C7B92', rule: '#243044',
      hairline: '#1A2434', 'table-head': '#141D2C', 'nav-on': '#1D2940', 'msg-hover': '#151E2E',
      human: '#78B4FF', 'human-wash': '#10233F', 'human-border': '#254A7C',
      agent: '#B6A0FF', 'agent-wash': '#1D1A3A', 'agent-border': '#40377A', 'agent-ink': '#CFC0FF',
      ok: '#4CC98A', 'ok-wash': '#0C2620', 'ok-border': '#1E5743', 'ok-ink': '#82DDB0',
      warn: '#EDB04C', 'warn-wash': '#2A2212', 'warn-border': '#5E4A1E', 'warn-ink': '#F4CA82',
      alert: '#FF8272', 'alert-wash': '#30171A', 'alert-border': '#703036', 'alert-ink': '#FFA99D',
      'bot-grey': '#8492A8', zip: '#DDA774', 'dot-off': '#3E4B61', 'presence-ring': '#8492A8', 'toggle-off': '#344056',
      ...lightFixed, 'shadow-color': '0 0 0', 'card-alpha': '40%', 'menu-alpha': '55%', 'savebar-alpha': '70%', 'scrim-alpha': '64%',
      hover: 'rgb(200 220 255 / 7%)', skeleton: '#1A2434', 'skeleton-hi': '#243044',
      accent: '#1B66D2', 'accent-hover': '#2470DC', 'on-accent': '#FFFFFF', 'control-border': '#63738C', 'control-bg': '#0B121D', 'focus-ring': '#78B4FF',
      'code-bg': '#0B121D', 'code-border': '#243044', 'code-ink': '#D2DBE8', selection: '#1D4480',
      'run-bg': '#131C2C', 'run-border': '#243044', 'run-rail': '#B6A0FF', 'run-state-ink': '#CFC0FF', 'run-pulse': '#B6A0FF',
      'todo-bg': '#131C2C', 'todo-border': '#243044', 'todo-track': '#243044', 'todo-fill': '#4CC98A',
      'elev-1': '0 1px 2px rgb(0 0 0 / 40%)', 'elev-2': '0 2px 4px rgb(0 0 0 / 40%), 0 10px 28px rgb(0 0 0 / 50%)', 'elev-3': '0 4px 8px rgb(0 0 0 / 45%), 0 24px 56px rgb(0 0 0 / 60%)',
      ...avatars('dark', 0.09, 250),
    },
  },
];

/** The text face each palette draws first: the one theme-boot.js preloads (everything else loads when first used). */
export const TEXT_FACE_FILE = {
  classic: '/fonts/inter-latin.woff2',
  graphite: '/fonts/inter-latin.woff2',
  linen: '/fonts/ibm-plex-sans-latin-400-normal.woff2',
  harbor: '/fonts/geist-latin-wght-normal.woff2',
};
