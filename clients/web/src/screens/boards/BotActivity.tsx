import type { BotSummary } from '@manythreads/shared';
import { BotWorkingIcon } from '../../shell/icons';
import { activityLabel } from './board';
import type { CardBot } from './activity';

/*
 * The mark that says bots are working on a card (PLAN P6-13): a bot icon with a gentle pulse (a still ring for people who ask for less
 * motion), the bots' names in the tooltip and the accessible label, and a count when more than one bot is on the card. A bot the team
 * roster does not know is named "A bot", never an id.
 */

type Props = { bots: readonly CardBot[]; roster: readonly BotSummary[]; className?: string };

export function BotActivity({ bots, roster, className }: Props) {
  if (bots.length === 0) return null;
  const running = bots.filter((b) => b.phase === 'running');
  const shown = running.length > 0 ? running : bots;
  const phase = running.length > 0 ? 'running' : 'queued';
  const names = shown.map((b) => roster.find((r) => r.actorId === b.actorId)?.name ?? 'A bot');
  const label = activityLabel(names, phase);
  return (
    <span className={`bd-bot ${phase}${className ? ` ${className}` : ''}`} role="img" aria-label={label} title={label} data-testid="bot-activity" data-phase={phase} data-count={shown.length}>
      <BotWorkingIcon />
      {shown.length > 1 ? <span className="bd-bot-n" aria-hidden="true">{shown.length}</span> : null}
    </span>
  );
}
