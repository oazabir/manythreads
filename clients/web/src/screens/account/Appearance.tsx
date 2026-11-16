import { useState, useId } from 'react';
import type { Appearance as AppearanceSetting, Density } from '@manythreads/shared';
import { isApiError } from '../../api/client';
import { useSession, useSessionState } from '../../app/session';
import { PageHeader } from '../../components/PageHeader';
import { Alert } from '../../components/ui';
import { ChoiceCards, ThemePicker } from '../../components/ThemePicker';
import { sayToast } from '../../kernel/toast';
import { applyAppearance } from '../../shell/appearance';
import { saveMyAppearance } from './appearanceApi';

/**
 * Set to true while the page below is the real setting. The Account menu lists the page only when this is true (the route exists either way,
 * so a link or a test can always reach it).
 */
export const APPEARANCE_PAGE_READY = true;

const DENSITIES: readonly { value: Density; label: string; hint: string }[] = [
  { value: 'comfortable', label: 'Comfortable', hint: 'Room between messages and a 32 px picture beside each.' },
  { value: 'compact', label: 'Compact', hint: 'More messages on a screen: tighter gaps, a smaller picture, and no picture on a follow-up line.' },
];

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

/** Account → Appearance: the theme (palette), light or dark, and the message density. A choice is saved the moment it is picked and drawn at once. */
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
      if (stored.theme !== next.theme || stored.density !== next.density || stored.palette !== next.palette) {
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
      <PageHeader title="Appearance" description="How manythreads looks to you: the theme, light or dark, and how close together messages sit." />
      <section className="block" aria-labelledby={`${uid}-theme`} data-landmark="appearance-theme">
        <h2 className="bh" id={`${uid}-theme`}>Theme</h2>
        <div className="block-body">
          <ThemePicker value={current} onChange={(change) => void pick(change)} />
        </div>
      </section>
      <section className="block" aria-labelledby={`${uid}-density`} data-landmark="appearance-density">
        <h2 className="bh" id={`${uid}-density`}>Messages</h2>
        <div className="block-body">
          <ChoiceCards
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
