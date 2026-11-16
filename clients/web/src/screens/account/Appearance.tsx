import { useId } from 'react';
import type { Density } from '@manythreads/shared';
import { PageHeader } from '../../components/PageHeader';
import { Alert } from '../../components/ui';
import { ChoiceCards, ThemePicker } from '../../components/ThemePicker';
import { sayToast } from '../../kernel/toast';
import { useAppearanceChoice } from '../../shell/useAppearanceChoice';

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
  const uid = useId();
  const { current, error, pick } = useAppearanceChoice({ onSaved: () => sayToast('Saved', { testId: 'appearance-saved' }) });

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
