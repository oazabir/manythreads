import { useState, useId, type ReactNode } from 'react';
import type { Appearance as AppearanceSetting, Density, ThemeChoice } from '@manythreads/shared';
import { isApiError } from '../../api/client';
import { useSession, useSessionState } from '../../app/session';
import { PageHeader } from '../../components/PageHeader';
import { Alert } from '../../components/ui';
import { sayToast } from '../../kernel/toast';
import { applyAppearance } from '../../shell/appearance';
import { saveMyAppearance } from './appearanceApi';

/**
 * Set to true while the page below is the real setting. The Account menu lists the page only when this is true (the route exists either way,
 * so a link or a test can always reach it).
 */
export const APPEARANCE_PAGE_READY = true;

const THEMES: readonly { value: ThemeChoice; label: string; hint: string }[] = [
  { value: 'system', label: 'System', hint: 'Matches the light or dark setting of your device.' },
  { value: 'light', label: 'Light', hint: 'Dark text on a light page.' },
  { value: 'dark', label: 'Dark', hint: 'Light text on a dark graphite page.' },
];

const DENSITIES: readonly { value: Density; label: string; hint: string }[] = [
  { value: 'comfortable', label: 'Comfortable', hint: 'Room between messages and a 32 px picture beside each.' },
  { value: 'compact', label: 'Compact', hint: 'More messages on a screen: tighter gaps, a smaller picture, and no picture on a follow-up line.' },
];

/** The little picture of a theme: a page with a bar, a message line and a bubble, drawn by the tokens of that theme's scope. */
function ThemeSample({ scope }: { scope: 'light' | 'dark' }) {
  return (
    <span className={`ap-sample theme-${scope}-scope`} aria-hidden="true">
      <span className="ap-bar" />
      <span className="ap-row">
        <span className="ap-dot" />
        <span className="ap-lines"><span className="ap-line" /><span className="ap-line short" /></span>
      </span>
      <span className="ap-row">
        <span className="ap-dot bot" />
        <span className="ap-lines"><span className="ap-line short" /></span>
      </span>
    </span>
  );
}

function ThemePreview({ value }: { value: ThemeChoice }) {
  if (value === 'system') {
    return (
      <span className="ap-prev ap-split" aria-hidden="true">
        <ThemeSample scope="light" />
        <ThemeSample scope="dark" />
      </span>
    );
  }
  return (
    <span className="ap-prev" aria-hidden="true">
      <ThemeSample scope={value} />
    </span>
  );
}

/** Three messages as they sit: the second continues the first author's run. The numbers are the preview's own, so each card shows its own density. */
function DensityPreview({ value }: { value: Density }) {
  return (
    <span className={`ap-prev ap-msgs ${value}`} aria-hidden="true">
      <span className="ap-msg"><span className="ap-dot" /><span className="ap-lines"><span className="ap-line" /></span></span>
      <span className="ap-msg cont"><span className="ap-lines"><span className="ap-line short" /></span></span>
      <span className="ap-msg"><span className="ap-dot bot" /><span className="ap-lines"><span className="ap-line" /></span></span>
    </span>
  );
}

function Choices<T extends string>({ legend, name, value, options, onPick, preview, testId }: {
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

/** Account → Appearance: the theme and the message density. A choice is saved the moment it is picked and drawn at once. */
export function Appearance() {
  const session = useSession();
  const { setSession } = useSessionState();
  const uid = useId();
  const current: AppearanceSetting = session.person.appearance;
  const [error, setError] = useState<string | null>(null);

  async function pick(change: Partial<AppearanceSetting>) {
    const next: AppearanceSetting = { ...current, ...change };
    setError(null);
    // drawn first, so the page answers the click; the session carries it so a later page reads the new value, and a failed save puts the old one back
    applyAppearance(next);
    setSession({ ...session, person: { ...session.person, appearance: next } });
    try {
      const stored = await saveMyAppearance(change);
      if (stored.theme !== next.theme || stored.density !== next.density) {
        applyAppearance(stored);
        setSession({ ...session, person: { ...session.person, appearance: stored } });
      }
      sayToast('Saved', { testId: 'appearance-saved' });
    } catch (err) {
      applyAppearance(current);
      setSession({ ...session, person: { ...session.person, appearance: current } });
      setError(isApiError(err) ? err.message : 'Could not save. Try again.');
    }
  }

  return (
    <>
      <PageHeader title="Appearance" description="How manythreads looks to you: light or dark, and how close together messages sit." />
      <section className="block" aria-labelledby={`${uid}-theme`} data-landmark="appearance-theme">
        <h2 className="bh" id={`${uid}-theme`}>Theme</h2>
        <div className="block-body">
          <Choices
            legend="Colour theme"
            name={`${uid}-theme-choice`}
            value={current.theme}
            options={THEMES}
            onPick={(theme) => void pick({ theme })}
            preview={(v) => <ThemePreview value={v} />}
            testId="appearance-theme"
          />
        </div>
      </section>
      <section className="block" aria-labelledby={`${uid}-density`} data-landmark="appearance-density">
        <h2 className="bh" id={`${uid}-density`}>Messages</h2>
        <div className="block-body">
          <Choices
            legend="Message spacing"
            name={`${uid}-density-choice`}
            value={current.density}
            options={DENSITIES}
            onPick={(density) => void pick({ density })}
            preview={(v) => <DensityPreview value={v} />}
            testId="appearance-density"
          />
          <p className="ap-note">Spacing applies to channels, direct messages and the thread panel. Chat and the Threads inbox keep their own layout.</p>
        </div>
      </section>
      {error ? <Alert>{error}</Alert> : null}
    </>
  );
}
