import type { MailMessage } from './types.ts';

export type RenderedMail = Pick<MailMessage, 'subject' | 'text' | 'html'>;

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

export type MailTemplateInput =
  | { template: 'verify'; to: string; name: string; url: string }
  | { template: 'reset'; to: string; name: string; url: string }
  | { template: 'invite'; to: string; inviterName: string; workspaceName: string; teamName: string | null; url: string };

/** Renders a template into a complete `MailMessage` for `to`. */
export function renderMail(input: MailTemplateInput): MailMessage {
  switch (input.template) {
    case 'verify':
      return { to: input.to, ...verifyEmailMail(input) };
    case 'reset':
      return { to: input.to, ...resetPasswordMail(input) };
    case 'invite':
      return { to: input.to, ...inviteMail(input) };
  }
}
