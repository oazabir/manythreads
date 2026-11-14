import type { AgentAuth, AgentAuthAttempt, AgentAuthMethod, BotRunner } from '@manythreads/shared';

/*
 * The words and rules of the agent sign-in on the Runners page (P25-09, docs/plans/acp.md section 4.1). Pure functions, so they are tested without a browser. The page
 * never shows an account e-mail (the server does not send one), and a code or an API key typed here goes up once and is cleared from the page the moment it is sent.
 */

/** Whether this runner is a gateway whose address answers as a Claude Code or Codex bridge: the only runners that sign in this way. */
export const hasAgentSignin = (r: Pick<BotRunner, 'kind' | 'agent'>): boolean => r.kind === 'hermes_gateway' && (r.agent === 'claude-code' || r.agent === 'codex');

export const AGENT_NAME: Record<'claude-code' | 'codex', string> = { 'claude-code': 'Claude Code', codex: 'Codex' };

/** An attempt that is still running: the page asks again every few seconds until it ends. */
export const isLive = (a: AgentAuthAttempt | null): boolean => a !== null && (a.state === 'starting' || a.state === 'waiting' || a.state === 'checking');

/** An attempt that waits for the person to type or paste something here. */
export const needsAnswer = (a: AgentAuthAttempt | null): boolean => a !== null && (a.state === 'needs_input' || (a.state === 'waiting' && a.action?.type === 'paste_code'));

/** How long to wait before asking again: quick while something is being checked, slower while the person is on the other page. */
export const pollDelayMs = (a: AgentAuthAttempt | null): number => (a === null ? 0 : a.state === 'waiting' ? 3000 : 1500);

/** The status line at the top of the dialog. */
export function statusWords(auth: AgentAuth): string {
  const name = AGENT_NAME[auth.agent];
  switch (auth.state) {
    case 'signed_in':
      return auth.kind === 'gateway' ? `${name} uses the workspace's model gateway. No sign-in is needed.` : `${name} is signed in.`;
    case 'signed_out':
      return `${name} is not signed in.`;
    case 'not_needed':
      return `${name} does not need a sign-in here.`;
    default:
      return `The bridge did not say whether ${name} is signed in.`;
  }
}

/** The label of one method's button: the agent's own name for it. */
export const methodLabel = (m: AgentAuthMethod): string => m.name;

/** What the person is asked to do for an attempt, in one sentence (the dialog shows the page and the code beside it). */
export function attemptWords(a: AgentAuthAttempt): string {
  if (a.message) return a.message;
  switch (a.state) {
    case 'starting':
      return 'Starting the sign-in.';
    case 'waiting':
      return a.action?.type === 'enter_code' ? 'Open the page, enter the code, then wait here.' : a.action?.type === 'paste_code' ? 'Open the page, sign in, then paste the code it shows below.' : 'Open the page and finish the sign-in. This page updates by itself.';
    case 'needs_input':
      return a.action?.type === 'give_key' ? 'Paste an API key below. It goes to the agent and is not kept here.' : 'The agent is waiting for you.';
    case 'checking':
      return 'Checking the sign-in.';
    case 'done':
      return 'Signed in.';
    case 'cancelled':
      return 'The sign-in was cancelled.';
    default:
      return 'The sign-in did not work.';
  }
}

/** What blocks the Send button, in a sentence, or null. The text itself is never put in a message. */
export function answerProblem(a: AgentAuthAttempt | null, text: string): string | null {
  if (!a || !needsAnswer(a)) return 'There is nothing to answer right now.';
  const t = text.trim();
  if (a.action?.type === 'give_key') return t.length < 8 ? 'An API key is at least 8 characters.' : t.length > 500 ? 'That is too long for an API key.' : null;
  if (t === '') return 'Paste the code first.';
  if (t.length > 2000) return 'That is too long for a code.';
  if (/[\r\n]/.test(t)) return 'The code is one line.';
  return null;
}

/** The body of an answer: a key or a code, by what the attempt asks for. */
export const answerBody = (a: AgentAuthAttempt, text: string): { attemptId: string; apiKey: string } | { attemptId: string; code: string } =>
  a.action?.type === 'give_key' ? { attemptId: a.id, apiKey: text.trim() } : { attemptId: a.id, code: text.trim() };

/** One sentence the page says after an action finishes (the polite status line of the Runners page). */
export const signedOutWords = (r: Pick<BotRunner, 'label'>): string => `${r.label} was signed out.`;
export const signedInDoneWords = (r: Pick<BotRunner, 'label'>): string => `${r.label} is signed in.`;
