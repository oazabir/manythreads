import { useEffect, useRef, useState } from 'react';

const COLOR_TOKENS = [
  '--paper',
  '--surface',
  '--shell',
  '--ink',
  '--txt',
  '--mute',
  '--faint',
  '--rule',
  '--nav-on',
  '--msg-hover',
  '--human',
  '--human-wash',
  '--agent',
  '--agent-wash',
  '--agent-ink',
  '--ok',
  '--ok-wash',
  '--ok-ink',
  '--warn',
  '--warn-wash',
  '--warn-ink',
  '--alert',
  '--alert-wash',
  '--alert-ink',
  '--skeleton',
  '--plate',
  '--accent',
  '--on-accent',
  '--control-border',
  '--focus-ring',
  '--code-bg',
  '--selection',
  '--run-bg',
  '--run-border',
  '--run-rail',
  '--todo-bg',
  '--todo-fill',
] as const;

const FONT_TOKENS = ['--sans', '--font-display', '--mono'] as const;

/** The four palettes (Classic is the look before themes) and the two modes each is drawn in. */
const PALETTES = [
  { id: 'classic', name: 'Classic' },
  { id: 'graphite', name: 'Graphite' },
  { id: 'linen', name: 'Linen' },
  { id: 'harbor', name: 'Harbor' },
] as const;
type PaletteId = (typeof PALETTES)[number]['id'];

const CHIPS = ['human', 'agent', 'ok', 'warn', 'alert'] as const;

type Scope = 'light' | 'dark';

/** Computed values of custom properties on one element, so each palette shows what its own scope resolves to. */
function useComputedTokens(names: readonly string[], scope: Scope, palette: PaletteId) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!ref.current) return;
    const style = getComputedStyle(ref.current);
    setValues(Object.fromEntries(names.map((n) => [n, style.getPropertyValue(n).trim()])));
  }, [names, scope, palette]);
  return { ref, values };
}

const ALL_TOKENS = [...COLOR_TOKENS, ...FONT_TOKENS];

/** One palette in one mode, with its swatches, buttons, chips and a run card, drawn inside a box that carries that palette's and mode's tokens. */
function Palette({ palette, name, scope }: { palette: PaletteId; name: string; scope: Scope }) {
  const { ref, values } = useComputedTokens(ALL_TOKENS, scope, palette);
  const key = `${palette}-${scope}`;
  return (
    <div ref={ref} className="dev-panel" data-palette={palette} data-theme={scope} data-testid={`palette-${key}`}>
      <h2>{name} {scope === 'light' ? 'light' : 'dark'}</h2>
      <div className="swatches">
        {COLOR_TOKENS.map((token) => (
          <div className="swatch" key={token} data-token={token}>
            <div className="chipcolor" style={{ background: `var(${token})` }} />
            <div className="meta">
              <span className="name">{token}</span>
              <span className="value" data-testid={`value-${key}${token}`}>
                {values[token] ?? ''}
              </span>
            </div>
          </div>
        ))}
      </div>

      <h2>Buttons</h2>
      <div className="row">
        <button className="btn" type="button">Default</button>
        <button className="btn primary" type="button">Primary</button>
        <button className="btn human" type="button">Human</button>
        <button className="btn quiet" type="button">Quiet</button>
        <button className="btn primary" type="button" disabled>Disabled</button>
      </div>

      <h2>Chips</h2>
      <div className="row">
        <span className="chip">neutral</span>
        {CHIPS.map((c) => (
          <span className={`chip ${c}`} key={c}>{c}</span>
        ))}
      </div>

      <h2>Run card and to-do</h2>
      <div className="rc" data-state="working">
        <div className="rcHead">
          <span className="rcPulse" />
          <span className="rcName">Engineer</span>
          <span className="rcState">Working</span>
          <span className="rcTime">12 s</span>
        </div>
      </div>
      <div className="td">
        <div className="tdHead">
          <span className="tdTitle">To do</span>
          <span className="tdCount">2 of 3</span>
        </div>
        <div className="tdBar"><span style={{ width: '66%' }} /></div>
      </div>
    </div>
  );
}

export function DevTokens() {
  return (
    <div className="dev" data-testid="app-frame">
      <h1>Design tokens</h1>
      <p className="lede">Developer page. Each palette and mode is read from the computed style of its own box (an element with data-palette and data-theme); the page itself follows the look in use.</p>

      {PALETTES.map((p) => (
        <section key={p.id} data-testid={`palette-group-${p.id}`}>
          <div className="dev-cols">
            <Palette palette={p.id} name={p.name} scope="light" />
            <Palette palette={p.id} name={p.name} scope="dark" />
          </div>
        </section>
      ))}

      <h2>Fonts</h2>
      <div className="fonts">
        <div className="sample sans" data-token="--sans">
          <small>--sans (the palette in use)</small>
          The quick brown fox jumps over the lazy dog 0123456789
        </div>
        <div className="sample display" data-token="--font-display">
          <small>--font-display</small>
          The quick brown fox jumps over the lazy dog 0123456789
        </div>
        <div className="sample mono" data-token="--mono">
          <small>--mono</small>
          The quick brown fox jumps over the lazy dog 0123456789
        </div>
      </div>
    </div>
  );
}
