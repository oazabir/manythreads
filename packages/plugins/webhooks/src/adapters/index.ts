import { repairBotMarkdown } from '@manythreads/shared';
import { adaptAlertmanager, adaptSentry, isAlertmanager, isSentry } from './alerts.ts';
import { adaptGeneric } from './generic.ts';
import { adaptGithub } from './github.ts';
import { adaptGitlab } from './gitlab.ts';
import { LIMITS, clip, codeBlock, compose, defang, stripControl, stripHtml } from './md.ts';
import { isObj, type Adapted, type Incoming } from './types.ts';

export type { Adapted, Incoming } from './types.ts';

/**
 * Turns one call into the Markdown a message carries (PLAN P14-14). Pure: the same call always gives the same answer, nothing is read or written.
 *
 * Which reader runs is decided by what the sender says about itself, in this order: GitHub (`X-GitHub-Event`), GitLab (`X-Gitlab-Event`), an alert
 * manager's fixed shape, then the generic JSON and Slack/Mattermost shape, then plain text. A JSON object with nothing a person could read is shown as
 * received, in a code block, so no call is silently lost. The result goes through the same Markdown repair a bot's message gets (a bare file name becomes
 * code, an open fence is closed).
 */
export function adapt(input: Incoming): Adapted {
  try {
    return adaptUnsafe(input);
  } catch {
    // a payload no reader expected (for example a JSON value nested so deeply that printing it overflows the stack) is the sender's mistake: a 400, never a 500
    return { kind: 'reject', reason: 'The payload could not be read.' };
  }
}

function adaptUnsafe(input: Incoming): Adapted {
  const github = input.headers['x-github-event'];
  const gitlab = input.headers['x-gitlab-event'];
  const done = (r: Adapted): Adapted => (r.kind === 'post' ? finish(r.text) : r);
  if (github !== undefined) {
    if (input.json === undefined) return { kind: 'reject', reason: 'A GitHub call must carry a JSON body.' };
    return done(adaptGithub(github.toLowerCase().trim(), input.json));
  }
  if (gitlab !== undefined) {
    if (input.json === undefined) return { kind: 'reject', reason: 'A GitLab call must carry a JSON body.' };
    return done(adaptGitlab(gitlab, input.json));
  }
  const json = input.json;
  if (isObj(json)) {
    if (isAlertmanager(json)) return done(adaptAlertmanager(json));
    if (isSentry(json, input.headers)) return done(adaptSentry(json));
    const generic = adaptGeneric(json);
    if (generic) return done(generic);
    const pretty = clip(JSON.stringify(json, null, 2) ?? '', 2000);
    return done({ kind: 'post', text: compose(['**A webhook call with no text field.** Shown as it arrived:', codeBlock(pretty, 'json')]) });
  }
  if (json !== undefined) {
    // a JSON array, number or string: show it as received
    return done({ kind: 'post', text: compose(['**A webhook call.** Shown as it arrived:', codeBlock(clip(JSON.stringify(json, null, 2) ?? '', 2000), 'json')]) });
  }
  const text = clip(defang(stripHtml(stripControl(input.raw))).replace(/\r\n?/g, '\n').trim(), 4000);
  if (text === '') return { kind: 'reject', reason: 'The call has no text to post.' };
  return done({ kind: 'post', text });
}

function finish(text: string): Adapted {
  const repaired = repairBotMarkdown(clip(text, LIMITS.message)).text;
  return { kind: 'post', text: repaired };
}

/**
 * Reads the body of a call: JSON when it parses (a Slack call may send `payload=<json>` as a form), otherwise nothing, and the caller treats the
 * body as plain text. Never throws.
 */
export function parseBody(contentType: string, raw: string): unknown {
  const type = contentType.toLowerCase();
  try {
    if (type.includes('application/x-www-form-urlencoded')) {
      const payload = new URLSearchParams(raw).get('payload');
      return payload === null ? undefined : (JSON.parse(payload) as unknown);
    }
    if (type.includes('json') || /^\s*[[{]/.test(raw)) return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  return undefined;
}
