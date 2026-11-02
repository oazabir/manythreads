import { DIGEST_UNPRINTABLE, digestDelayLabel } from '@manythreads/shared';
import type { MailMessage } from './types.ts';

export type RenderedMail = Pick<MailMessage, 'subject' | 'text' | 'html'> & Pick<Partial<MailMessage>, 'headers'>;

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

interface Layout {
  heading: string;
  paragraphs: string[];
  action: { label: string; url: string };
  footer: string;
}

/** Plain text and a deliberately plain HTML body (no images, no remote CSS) from the same content. */
function render(subject: string, layout: Layout): RenderedMail {
  const text = [
    layout.heading,
    '',
    ...layout.paragraphs,
    '',
    `${layout.action.label}: ${layout.action.url}`,
    '',
    layout.footer,
    '',
  ].join('\n');
  const html = [
    '<!doctype html>',
    '<html><body style="font-family: sans-serif; line-height: 1.5;">',
    `<h2 style="font-size: 18px;">${escapeHtml(layout.heading)}</h2>`,
    ...layout.paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`),
    `<p><a href="${escapeHtml(layout.action.url)}">${escapeHtml(layout.action.label)}</a></p>`,
    `<p>If the button does not work, paste this link into your browser:<br>${escapeHtml(layout.action.url)}</p>`,
    `<p style="color: dimgray; font-size: 13px;">${escapeHtml(layout.footer)}</p>`,
    '</body></html>',
    '',
  ].join('\n');
  return { subject, text, html };
}

/** Sent to confirm an address. */
export function verifyEmailMail(input: { name: string; url: string }): RenderedMail {
  return render('Confirm your email address', {
    heading: `Hi ${input.name}, confirm your email`,
    paragraphs: ['Use the link below to confirm this address for your manythreads account. It works once and expires in 24 hours.'],
    action: { label: 'Confirm email', url: input.url },
    footer: 'If you did not ask for this, you can ignore this message.',
  });
}

/** Sent for a password reset request. */
export function resetPasswordMail(input: { name: string; url: string }): RenderedMail {
  return render('Reset your password', {
    heading: `Hi ${input.name}, reset your password`,
    paragraphs: ['Someone asked to reset the password of your manythreads account. The link below works once and expires in 1 hour.'],
    action: { label: 'Choose a new password', url: input.url },
    footer: 'If this was not you, ignore this message: your password has not changed.',
  });
}

/** Sent when someone invites a person to a workspace (and optionally a team). */
export function inviteMail(input: {
  inviterName: string;
  workspaceName: string;
  teamName: string | null;
  url: string;
}): RenderedMail {
  const where = input.teamName ? `the ${input.teamName} team in ${input.workspaceName}` : input.workspaceName;
  return render(`${input.inviterName} invited you to ${input.workspaceName}`, {
    heading: `You are invited to ${input.workspaceName}`,
    paragraphs: [`${input.inviterName} invited you to join ${where} on manythreads. The invitation expires in 7 days.`],
    action: { label: 'Accept the invitation', url: input.url },
    footer: 'If you were not expecting this, you can ignore this message.',
  });
}

/** Sent to workspace owners and admins when a health check of the server trips or clears (ops-health). */
export function opsAlertMail(input: { workspaceName: string; state: 'breached' | 'recovered'; title: string; detail: string; url: string }): RenderedMail {
  const tag = input.state === 'breached' ? 'Needs attention' : 'Back to normal';
  return render(`[${input.workspaceName}] ${input.title}`, {
    heading: `${tag}: ${input.title}`,
    paragraphs: [
      input.detail,
      `This is one of the checks manythreads runs on itself every minute for ${input.workspaceName}. You get one mail when a check trips and one when it clears.`,
    ],
    action: { label: 'Open System health', url: input.url },
    footer: 'Workspace owners and admins get these. The limits are set in the server environment (docs/deploy/monitoring.md).',
  });
}

/** The headers that make a mail a one-click unsubscribe (RFC 8058): the address, and the statement that a POST to it is all that is needed. */
export function listUnsubscribeHeaders(url: string): Record<string, string> {
  // The value goes into a header line: refuse anything that could end the line or the angle brackets.
  if (!/^https?:\/\/[^\s<>"]{1,1000}$/.test(url)) throw new Error('the unsubscribe address is not a plain http(s) link');
  return { 'List-Unsubscribe': `<${url}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
}

/** One line of at most `max` characters (counted as code points) from text a person wrote; linear in the input. */
export function oneLine(text: string, max: number): string {
  const line = text.slice(0, max * 8).replace(DIGEST_UNPRINTABLE, ' ').replace(/\s+/g, ' ').trim();
  const chars = [...line.slice(0, max * 2 + 2)];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}
const httpUrl = (url: string): string => (/^https?:\/\/[^\s<>"]{1,1000}$/.test(url) ? url : '#');

/**
 * The email digest (PLAN P14-09): what a person has not read, grouped by channel, with a link to each message and a footer that unsubscribes in one
 * click. Every name and excerpt is text somebody else wrote, so it is cut to one line, stripped of control characters and escaped in the HTML body;
 * the plain text part carries it as text.
 */
export function digestMail(input: {
  name: string;
  groups: ReadonlyArray<{ title: string; items: ReadonlyArray<{ sender: string; excerpt: string; url: string }> }>;
  more: number;
  openUrl: string;
  unsubscribeUrl: string;
  settingsUrl: string;
  delayMinutes: number;
}): RenderedMail & { headers: Record<string, string> } {
  const groups = input.groups.map((g) => ({
    title: oneLine(g.title, 80) || 'Conversation',
    items: g.items.map((i) => ({ sender: oneLine(i.sender, 60) || 'Someone', excerpt: oneLine(i.excerpt, 140), url: httpUrl(i.url) })),
  }));
  const shown = groups.reduce((n, g) => n + g.items.length, 0);
  const total = shown + Math.max(0, Math.floor(input.more));
  // `total` counts what arrived since the last digest and is still unread, not everything the person has unread: the subject says "new".
  const subject = total === 1 ? '1 new message for you' : `${total} new messages for you`;
  const name = oneLine(input.name, 60) || 'there';
  const moreLine = input.more > 0 ? `and ${input.more} more` : '';
  const intro = 'You have been away for a while. These mentions, replies and direct messages are still unread.';
  const delay = digestDelayLabel(Number.isFinite(input.delayMinutes) && input.delayMinutes > 0 ? Math.floor(input.delayMinutes) : 60);
  const footer = `You get this mail because you were away and had unread mentions or messages. You get at most one email every ${delay}.`;

  const text = [
    `Hi ${name}, here is what you missed`,
    '',
    intro,
    '',
    ...groups.flatMap((g) => [g.title, ...g.items.flatMap((i) => [`  ${i.sender}: ${i.excerpt}`, `  ${i.url}`]), '']),
    ...(moreLine ? [`${moreLine}.`, ''] : []),
    `Open manythreads: ${input.openUrl}`,
    '',
    '--',
    footer,
    `Stop these emails (one click): ${input.unsubscribeUrl}`,
    `Turn them back on or change how long you are away first: ${input.settingsUrl}`,
    '',
  ].join('\n');

  const html = [
    '<!doctype html>',
    '<html><body style="font-family: sans-serif; line-height: 1.5;">',
    `<h2 style="font-size: 18px;">${escapeHtml(`Hi ${name}, here is what you missed`)}</h2>`,
    `<p>${escapeHtml(intro)}</p>`,
    ...groups.flatMap((g) => [
      `<h3 style="font-size: 15px; margin-bottom: 4px;">${escapeHtml(g.title)}</h3>`,
      '<ul style="margin-top: 0;">',
      ...g.items.map((i) => `<li><strong>${escapeHtml(i.sender)}</strong>: ${escapeHtml(i.excerpt)} <a href="${escapeHtml(i.url)}">Open</a></li>`),
      '</ul>',
    ]),
    ...(moreLine ? [`<p>${escapeHtml(moreLine)}.</p>`] : []),
    `<p><a href="${escapeHtml(httpUrl(input.openUrl))}">Open manythreads</a></p>`,
    `<p style="color: dimgray; font-size: 13px;">${escapeHtml(footer)}<br>`,
    `<a href="${escapeHtml(httpUrl(input.unsubscribeUrl))}">Stop these emails</a> (one click) &middot; <a href="${escapeHtml(httpUrl(input.settingsUrl))}">Email settings</a></p>`,
    '</body></html>',
    '',
  ].join('\n');
  return { subject, text, html, headers: listUnsubscribeHeaders(input.unsubscribeUrl) };
}

export type MailTemplateInput =
  | {
      template: 'digest';
      to: string;
      name: string;
      groups: ReadonlyArray<{ title: string; items: ReadonlyArray<{ sender: string; excerpt: string; url: string }> }>;
      more: number;
      openUrl: string;
      unsubscribeUrl: string;
      settingsUrl: string;
      delayMinutes: number;
    }
  | { template: 'verify'; to: string; name: string; url: string }
  | { template: 'reset'; to: string; name: string; url: string }
  | { template: 'invite'; to: string; inviterName: string; workspaceName: string; teamName: string | null; url: string }
  | { template: 'ops_alert'; to: string; workspaceName: string; state: 'breached' | 'recovered'; title: string; detail: string; url: string };

/** Renders a template into a complete `MailMessage` for `to`. */
export function renderMail(input: MailTemplateInput): MailMessage {
  switch (input.template) {
    case 'digest':
      return { to: input.to, ...digestMail(input) };
    case 'verify':
      return { to: input.to, ...verifyEmailMail(input) };
    case 'reset':
      return { to: input.to, ...resetPasswordMail(input) };
    case 'invite':
      return { to: input.to, ...inviteMail(input) };
    case 'ops_alert':
      return { to: input.to, ...opsAlertMail(input) };
  }
}
