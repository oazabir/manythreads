import { Link } from 'react-router';
import type { BotDeployResponse } from '@manythreads/shared';
import { STEP_TITLE, headline, needsAttention, stateLabel } from './deploy-run';

/*
 * What a Deploy came to (PLAN P8-34): one headline and the three parts in order, each with its own words. A refused part says what to do and where; a part that was not attempted is
 * shown quietly. The panel shows what the server answered and decides nothing.
 */
export function DeployResult({ slug, result, onClose }: { slug: string; result: BotDeployResponse; onClose: () => void }) {
  const head = headline(result);
  return (
    <section className={`b-deploy b-deploy-${head.tone}`} aria-label="Deploy result" data-testid="deploy-result">
      <div className="b-deploy-top">
        <h2 className="b-deploy-h" data-testid="deploy-headline">{head.text}</h2>
        <button type="button" className="btn s" onClick={onClose} data-testid="deploy-close">Close</button>
      </div>
      <ul className="b-deploy-list">
        {result.outcomes.map((o) => (
          <li key={o.step} className={`b-deploy-row ${needsAttention(o) ? 'bad' : o.state === 'not_run' ? 'quiet' : ''}`} data-testid={`deploy-outcome-${o.step}`} data-state={o.state}>
            <span className="b-deploy-step">{STEP_TITLE[o.step]}</span>
            <span className="b-deploy-state">{stateLabel(o.state)}</span>
            <span className="b-deploy-msg">{o.message}</span>
          </li>
        ))}
      </ul>
      {result.outcomes.some((o) => o.step === 'connection' && needsAttention(o)) ? (
        <p className="b-deploy-more">
          <Link to={`/t/${slug}/connections`} data-testid="deploy-open-connections">Open the team's Connections page</Link>
        </p>
      ) : null}
    </section>
  );
}
