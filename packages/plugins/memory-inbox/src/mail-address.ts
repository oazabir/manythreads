import type { MailEnvelope } from '@manythreads/sdk/extract';
import type { InboxMailAuth } from '@manythreads/shared';

// The pure rules of the email door (PLAN P8-19): the address a team has, which teams a message is for, and what the sender check says. No database, no I/O, so each
// rule is tested on its own. docs/plugins/memory-inbox.md "Email to the team's address".

/** The domain team addresses are made on when `MANYTHREADS_MAIL_DOMAIN` is not set. `.invalid` never resolves: the address is shown, and nothing can be sent to it until an admin names the real domain. */
export const MAIL_DOMAIN_DEFAULT = 'mail.manythreads.invalid';
/** The most teams one message is delivered to; the rest of its recipients are ignored, so one message cannot be a way to fill every team's inbox. */
export const MAIL_TEAMS_MAX = 5;

const DOMAIN = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;

export function mailDomain(env: Record<string, string | undefined> = process.env): string {
  const raw = (env['MANYTHREADS_MAIL_DOMAIN'] ?? '').trim().toLowerCase();
  return DOMAIN.test(raw) ? raw : MAIL_DOMAIN_DEFAULT;
}

/** `inbox+engineering@mail.example.com`: the mailbox's short name, a plus, the team's slug. */
export const inboxAddress = (connectionSlug: string, teamSlug: string, domain: string): string => `${connectionSlug}+${teamSlug}@${domain}`;

/** The team slug an address names on this mailbox and domain, or null when it is any other address. */
export function teamSlugOfAddress(address: string, connectionSlug: string, domain: string): string | null {
  const at = address.lastIndexOf('@');
  if (at < 0 || address.slice(at + 1).toLowerCase() !== domain) return null;
  const local = address.slice(0, at).toLowerCase();
  const prefix = `${connectionSlug}+`;
  if (!local.startsWith(prefix)) return null;
  const slug = local.slice(prefix.length);
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(slug) ? slug : null;
}

/** The teams a message is addressed to (To, Cc and what the receiving server wrote as Delivered-To), first mention first, each once. */
export function teamSlugsOf(envelope: Pick<MailEnvelope, 'to' | 'cc' | 'deliveredTo'>, connectionSlug: string, domain: string): string[] {
  const out: string[] = [];
  for (const address of [...envelope.deliveredTo, ...envelope.to, ...envelope.cc]) {
    const slug = teamSlugOfAddress(address, connectionSlug, domain);
    if (slug !== null && !out.includes(slug)) out.push(slug);
  }
  return out;
}

/**
 * What the sending domain proved, from what the transport read when it took the message in: `pass` when at least one of SPF and DKIM passed and neither
 * failed; `fail` for everything else, including "no result" and a soft fail. A message nobody could vouch for is treated as one that failed the check.
 */
export function combineAuth(spf: InboxMailAuth | undefined, dkim: InboxMailAuth | undefined): 'pass' | 'fail' {
  if (spf === 'fail' || dkim === 'fail') return 'fail';
  return spf === 'pass' || dkim === 'pass' ? 'pass' : 'fail';
}

/**
 * The item's sender check (`sender_check`): `fail` when the check failed; `pass` when it passed AND the sender is a person of this team (or a workspace admin),
 * which is what lets the mail straight in; `none` when it passed for an address the team does not know (the team's `allowEmailFrom` then decides).
 */
export const senderCheckOf = (auth: 'pass' | 'fail', trustedPerson: boolean): 'pass' | 'fail' | 'none' => (auth === 'fail' ? 'fail' : trustedPerson ? 'pass' : 'none');
