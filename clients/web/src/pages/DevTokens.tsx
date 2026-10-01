import { useEffect, useState } from 'react';

const COLOR_TOKENS = [
  '--paper',
  '--surface',
  '--shell',
  '--ink',
  '--mute',
  '--faint',
  '--rule',
  '--human',
  '--agent',
  '--agent-wash',
  '--ok',
  '--warn',
  '--alert',
  '--alert-wash',
] as const;

const FONT_TOKENS = ['--sans', '--mono'] as const;

const CHIPS = ['human', 'agent', 'ok', 'warn', 'alert'] as const;

function useComputedTokens(names: readonly string[]): Record<string, string> {
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => {
    const style = getComputedStyle(document.documentElement);
    setValues(Object.fromEntries(names.map((n) => [n, style.getPropertyValue(n).trim()])));
  }, [names]);
  return values;
}

const ALL_TOKENS = [...COLOR_TOKENS, ...FONT_TOKENS];

export function DevTokens() {
  const values = useComputedTokens(ALL_TOKENS);
  return (
    <div className="dev" data-testid="app-frame">
      <h1>Design tokens</h1>
      <p className="lede">Developer page. Values are read from the computed style of :root.</p>

      <h2>Colours</h2>
      <div className="swatches">
        {COLOR_TOKENS.map((name) => (
          <div className="swatch" key={name} data-token={name}>
            <div className="chipcolor" style={{ background: `var(${name})` }} />
            <div className="meta">
              <span className="name">{name}</span>
              <span className="value" data-testid={`value${name}`}>
                {values[name] ?? ''}
              </span>
            </div>
          </div>
        ))}
      </div>

      <h2>Fonts</h2>
      <div className="fonts">
        <div className="sample sans" data-token="--sans">
          <small>--sans · {values['--sans'] ?? ''}</small>
          Inter Tight. The quick brown fox jumps over the lazy dog 0123456789
        </div>
        <div className="sample mono" data-token="--mono">
          <small>--mono · {values['--mono'] ?? ''}</small>
          JetBrains Mono. The quick brown fox jumps over the lazy dog 0123456789
        </div>
      </div>

      <h2>Buttons</h2>
      <div className="row">
        <span className="label">default</span>
        <button className="btn" type="button">Default</button>
        <button className="btn primary" type="button">Primary</button>
        <button className="btn human" type="button">Human</button>
        <button className="btn quiet" type="button">Quiet</button>
      </div>
      <div className="row">
        <span className="label">hover</span>
        <button className="btn hover" type="button">Default</button>
        <button className="btn primary hover" type="button">Primary</button>
        <button className="btn human hover" type="button">Human</button>
        <button className="btn quiet hover" type="button">Quiet</button>
      </div>
      <div className="row">
        <span className="label">disabled</span>
        <button className="btn" type="button" disabled>Default</button>
        <button className="btn primary" type="button" disabled>Primary</button>
        <button className="btn human" type="button" disabled>Human</button>
        <button className="btn quiet" type="button" disabled>Quiet</button>
      </div>

      <h2>Chips</h2>
      <div className="row">
        <span className="label">default</span>
        <span className="chip">neutral</span>
        {CHIPS.map((c) => (
          <span className={`chip ${c}`} key={c}>{c}</span>
        ))}
      </div>
    </div>
  );
}
