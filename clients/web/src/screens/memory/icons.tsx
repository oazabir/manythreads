import { CheckmarkCircleIcon, DocumentIcon, QuestionCircleIcon, ShieldCheckmarkIcon } from '@proicons/react';
import { proIcon } from '../../components/proicon';
import { TEAM_TRUST_WORDS, type TrustTier } from './conceptWords';

/* The trust icon of a Concepts row and the picture of an empty preview pane: ProIcons drawn like the rest of the app's icons (shell/icons.tsx). */

const ICONS = {
  'human-reviewed': proIcon(ShieldCheckmarkIcon, 16),
  'machine-confirmed': proIcon(CheckmarkCircleIcon, 16),
  unverified: proIcon(QuestionCircleIcon, 16),
} as const;

export const PreviewEmptyIcon = proIcon(DocumentIcon, 32, 1.25);

/** One icon for how far a concept is trusted. It carries its meaning as a name, so a screen reader and a hover both say it. */
export function TrustIcon({ tier, withWords = false }: { tier: TrustTier; withWords?: boolean }) {
  const Icon = ICONS[tier];
  const words = TEAM_TRUST_WORDS[tier];
  if (withWords) {
    return (
      <span className={`mc-trust ${tier}`} data-trust={tier}>
        <Icon />
        <span>{words}</span>
      </span>
    );
  }
  return (
    <span className={`mc-trust ${tier}`} role="img" aria-label={words} title={words} data-trust={tier}>
      <Icon />
    </span>
  );
}
