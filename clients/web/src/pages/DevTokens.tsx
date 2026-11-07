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
] as const;

const FONT_TOKENS = ['--sans', '--mono'] as const;

const CHIPS = ['human', 'agent', 'ok', 'warn', 'alert'] as const;

type Scope = 'light' | 'dark';

/** Computed values of custom properties on one element, so each palette shows what its own scope resolves to. */
function useComputedTokens(names: readonly string[], scope: Scope) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!ref.current) return;
    const style = getComputedStyle(ref.current);
    setValues(Object.fromEntries(names.map((n) => [n, style.getPropertyValue(n).trim()])));
  }, [names, scope]);
  return { ref, values };
}

const ALL_TOKENS = [...COLOR_TOKENS, ...FONT_TOKENS];

/** One palette (light or dark) with its swatches, buttons and chips, drawn inside a scope box that carries that theme's tokens. */
function Palette({ scope }: { scope: Scope }) {
  const { ref, values } = useComputedTokens(ALL_TOKENS, scope);
  return (
    <div ref={ref} className={`dev-panel theme-${scope}-scope`} data-testid={`palette-${scope}`}>
      <h2>{scope === 'light' ? 'Light' : 'Dark'} colours</h2>
      <div className="swatches">
        {COLOR_TOKENS.map((name) => (
          <div className="swatch" key={name} data-token={name}>
            <div className="chipcolor" style={{ background: `var(${name})` }} />
            <div className="meta">
              <span className="name">{name}</span>
              <span className="value" data-testid={`value-${scope}${name}`}>
                {values[name] ?? ''}
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
    </div>
  );
}

export function DevTokens() {
  return (
    <div className="dev" data-testid="app-frame">
      <h1>Design tokens</h1>
      <p className="lede">Developer page. Each palette is read from the computed style of its own box; the page itself follows the theme in use.</p>

      <div className="dev-cols">
        <Palette scope="light" />
        <Palette scope="dark" />
      </div>

      <h2>Fonts</h2>
      <div className="fonts">
        <div className="sample sans" data-token="--sans">
          <small>--sans</small>
          Inter. The quick brown fox jumps over the lazy dog 0123456789
        </div>
        <div className="sample mono" data-token="--mono">
          <small>--mono</small>
          JetBrains Mono. The quick brown fox jumps over the lazy dog 0123456789
        </div>
      </div>
    </div>
  );
}
