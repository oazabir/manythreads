import { useId, type ReactNode } from 'react';
import type { Palette, ThemeChoice } from '@manythreads/shared';

/*
 * The theme picker (P28-05): choose a palette (Classic, Graphite, Linen or Harbor) and a mode (System, Light or Dark), each as a card with a small live
 * sample drawn by the tokens of that palette and mode. It holds no state and talks to no server: the page that embeds it (Settings → Appearance, and the
 * onboarding wizard of Phase 27) owns the value, applies a change at once and saves it.
 *
 *   <ThemePicker value={{ palette, theme }} onChange={(change) => save(change)} />
 *
 * A sample is a box with `data-palette` and `data-theme` set, so it reads the same custom properties as the page does (tokens.css, styles/themes/*.css).
 * Test ids: `<testId>-palette-<id>` and `<testId>-theme-<choice>` on each card (the radio is inside).
 */

export interface PaletteOption {
  value: Palette;
  label: string;
  hint: string;
}

/** The four looks, in the order they are offered. `classic` is the look the app had before themes. */
export const PALETTE_OPTIONS: readonly PaletteOption[] = [
  { value: 'graphite', label: 'Graphite', hint: 'Calm and exact: neutral greys, thin borders, colour only where something is happening.' },
  { value: 'linen', label: 'Linen', hint: 'Warm and unhurried: paper tones, a serif for titles, soft shadows.' },
  { value: 'harbor', label: 'Harbor', hint: 'Clear and confident: white panels, one strong blue for what you can press.' },
  { value: 'classic', label: 'Classic', hint: 'The original look of manythreads.' },
];

export const MODE_OPTIONS: readonly { value: ThemeChoice; label: string; hint: string }[] = [
  { value: 'system', label: 'System', hint: 'Matches the light or dark setting of your device.' },
  { value: 'light', label: 'Light', hint: 'Dark text on a light page.' },
  { value: 'dark', label: 'Dark', hint: 'Light text on a dark page.' },
];

/** The little picture of a look: a sidebar, a title, a message, a bot's run card and a primary button, drawn by the tokens of its own palette and mode. */
export function ThemeSample({ palette, mode }: { palette: Palette; mode: 'light' | 'dark' }) {
  return (
    <span className="tp-sample" data-palette={palette} data-theme={mode} data-testid={`theme-sample-${palette}-${mode}`} aria-hidden="true">
      <span className="tp-side">
        <span className="tp-side-row on" />
        <span className="tp-side-row" />
        <span className="tp-side-row" />
      </span>
      <span className="tp-main">
        <span className="tp-title">Aa</span>
        <span className="tp-msg">
          <span className="tp-dot" />
          <span className="tp-lines"><span className="tp-line" /><span className="tp-line short" /></span>
        </span>
        <span className="tp-run">
          <span className="tp-pulse" />
          <span className="tp-line short" />
        </span>
        <span className="tp-actions">
          <span className="tp-btn" />
          <span className="tp-chip" />
        </span>
      </span>
    </span>
  );
}

/** A palette is shown in both modes side by side; a mode is shown in the palette that is chosen (System shows both). */
function PalettePreview({ palette }: { palette: Palette }) {
  return (
    <span className="tp-prev" aria-hidden="true">
      <ThemeSample palette={palette} mode="light" />
      <ThemeSample palette={palette} mode="dark" />
    </span>
  );
}

function ModePreview({ palette, mode }: { palette: Palette; mode: ThemeChoice }) {
  if (mode === 'system') {
    return (
      <span className="tp-prev" aria-hidden="true">
        <ThemeSample palette={palette} mode="light" />
        <ThemeSample palette={palette} mode="dark" />
      </span>
    );
  }
  return (
    <span className="tp-prev" aria-hidden="true">
      <ThemeSample palette={palette} mode={mode} />
    </span>
  );
}

/** A radio group drawn as cards. Also used by the message-spacing setting of the Appearance page. */
export function ChoiceCards<T extends string>({ legend, name, value, options, onPick, preview, testId }: {
  legend: string;
  name: string;
  value: T;
  options: readonly { value: T; label: string; hint: string }[];
  onPick: (v: T) => void;
  preview: (v: T) => ReactNode;
  testId: string;
}) {
  return (
    <fieldset className="ap-group" data-testid={testId}>
      <legend className="ap-legend">{legend}</legend>
      <div className="ap-cards">
        {options.map((o) => (
          <label key={o.value} className={`ap-card${value === o.value ? ' on' : ''}`} data-testid={`${testId}-${o.value}`}>
            <input type="radio" className="sr-only" name={name} value={o.value} checked={value === o.value} onChange={() => onPick(o.value)} />
            {preview(o.value)}
            <span className="ap-label">{o.label}</span>
            <span className="ap-hint">{o.hint}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function ThemePicker({ value, onChange, testId = 'appearance', showMode = true }: {
  value: { palette: Palette; theme: ThemeChoice };
  onChange: (change: { palette?: Palette; theme?: ThemeChoice }) => void;
  /** prefix of the test ids, `appearance` on the settings page */
  testId?: string;
  /** false when a page asks only for the palette (it keeps its own mode control) */
  showMode?: boolean;
}) {
  const uid = useId();
  return (
    <div className="tp" data-testid={`${testId}-picker`}>
      <ChoiceCards
        legend="Colours, type and corners"
        name={`${uid}-palette`}
        value={value.palette}
        options={PALETTE_OPTIONS}
        onPick={(palette) => onChange({ palette })}
        preview={(p) => <PalettePreview palette={p} />}
        testId={`${testId}-palette`}
      />
      {showMode ? (
        <ChoiceCards
          legend="Light or dark"
          name={`${uid}-mode`}
          value={value.theme}
          options={MODE_OPTIONS}
          onPick={(theme) => onChange({ theme })}
          preview={(m) => <ModePreview palette={value.palette} mode={m} />}
          testId={`${testId}-theme`}
        />
      ) : null}
    </div>
  );
}
