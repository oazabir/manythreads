import type { Approval, ApprovalSource } from '@manythreads/shared';

/*
 * The risk tag of a waiting request. It is read from why the request is waiting (its source), not from the tool: a protected environment
 * is the sharpest case, a held message is about private data, a strict hand-off is routine, and a flagged tool just needs a person.
 * `tone` is the shared chip colour: red `alert`, amber `warn`, or a plain grey chip (`neutral`).
 */
export interface Risk {
  label: string;
  tone: 'alert' | 'warn' | 'neutral';
  /** A sentence for the tooltip. */
  hint: string;
}

const RISK: Record<ApprovalSource, Risk> = {
  environment: { label: 'Production', tone: 'alert', hint: 'This would act on a protected environment.' },
  dlp: { label: 'Sensitive data', tone: 'warn', hint: 'The guard found something sensitive in what the bot was about to send.' },
  dispatch: { label: 'Strict hand-off', tone: 'neutral', hint: 'This team asks a person to approve every hand-off.' },
  grant: { label: 'Needs approval', tone: 'warn', hint: 'This tool is set to ask a person first.' },
};

export const riskOf = (a: Pick<Approval, 'source'>): Risk => RISK[a.source];

/** The CSS class of the tag: the shared `.chip` with a tone. */
export const riskClass = (r: Risk): string => (r.tone === 'neutral' ? 'chip' : `chip ${r.tone}`);
