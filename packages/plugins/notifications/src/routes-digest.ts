import { HttpError, type HttpRequest, type HttpResponse, type PluginContext, type PluginTx } from '@manythreads/sdk';
import {
  DIGEST_DELAY_DEFAULT,
  GetDigestSettingsResponse,
  NotificationsDigestUnsubscribedEvent,
  PutDigestSettingsRequest,
  PutDigestSettingsResponse,
  digestUnsubscribePageRoute,
  digestUnsubscribeRoute,
  getDigestSettingsRoute,
  putDigestSettingsRoute,
  type DigestSettings,
} from '@manythreads/shared';
import { ACCOUNT_ANCHOR } from './digest.ts';
import { digestMacMatches, parseDigestToken } from './digest-token.ts';
import { json, route } from './http.ts';

/** The signed-in person (people.id); the digest belongs to a person, so a bot has none. */
async function callerPerson(tx: PluginTx): Promise<string> {
  const row = (await tx.query<{ id: string | null }>('SELECT app.person_id() AS id')).rows[0];
  if (!row?.id) throw new HttpError(403, 'forbidden', 'The email digest belongs to people');
  return row.id;
}

async function settingsOf(tx: PluginTx, personId: string): Promise<DigestSettings> {
  const row = (await tx.query<{ enabled: boolean; delay_minutes: number; last_digest_at: Date | null }>(
    'SELECT enabled, delay_minutes, last_digest_at FROM app.notification_digest WHERE person_id = $1::uuid',
    [personId],
  )).rows[0];
  // A verified address that is the one the person signs in with: the mail goes there, so without it there is nowhere to send.
  const mail = (await tx.query<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM app.person_emails e JOIN app.people p ON p.id = e.person_id
                     WHERE e.person_id = $1::uuid AND e.verified_at IS NOT NULL AND lower(e.email) = lower(p.primary_email)) AS ok`,
    [personId],
  )).rows[0];
  return {
    enabled: row?.enabled ?? true,
    delayMinutes: row?.delay_minutes ?? DIGEST_DELAY_DEFAULT,
    emailAvailable: mail?.ok === true,
    lastSentAt: row?.last_digest_at ? row.last_digest_at.toISOString() : null,
  };
}

// The pages of the unsubscribe link -----------------------------------------------------------------------------------------------------
// Small server-written pages with no script and no text from anywhere but this file: the link works with no sign-in, in any mail program's browser.

const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
} as const;

function page(status: number, title: string, body: string): HttpResponse {
  const html = [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${title}</title>`,
    '<style>',
    ':root { color-scheme: light dark; }',
    'body { font-family: system-ui, sans-serif; line-height: 1.5; max-width: 30rem; margin: 12vh auto 0; padding: 0 1.25rem; }',
    'h1 { font-size: 1.4rem; }',
    'button, .back { font: inherit; padding: 0.55rem 1rem; border-radius: 0.4rem; border: 1px solid currentColor; background: transparent; color: inherit; cursor: pointer; text-decoration: none; display: inline-block; }',
    '</style></head><body><main>',
    body,
    '</main></body></html>',
  ].join('\n');
  return { status, body: Buffer.from(html, 'utf8'), headers: { ...PAGE_HEADERS } };
}

const stopPage = (): HttpResponse =>
  page(
    200,
    'Email digest',
    [
      '<h1>Stop these emails?</h1>',
      '<p>manythreads emails you a short list of the mentions and direct messages you have not read, when you have been away for a while.</p>',
      '<form method="post"><input type="hidden" name="List-Unsubscribe" value="One-Click"><button type="submit">Stop these emails</button></form>',
    ].join('\n'),
  );

const doneBody = (accountUrl: string): string =>
  [
    '<h1>You will no longer get these emails</h1>',
    '<p>Nothing else about your account has changed. You can turn them back on any time in your account settings, under Notifications.</p>',
    `<p><a class="back" href="${accountUrl}">Turn them back on</a></p>`,
  ].join('\n');

const donePage = (accountUrl: string): HttpResponse => page(200, 'Email digest off', doneBody(accountUrl));

const invalidPage = (): HttpResponse =>
  page(404, 'Link not valid', '<h1>This link is not valid</h1>\n<p>Open the latest digest email and use the link at its foot, or change this in your account settings, under Notifications.</p>');

type TokenCheck = { state: 'invalid' } | { state: 'on' | 'off'; changed: boolean };

/**
 * Checks a token against the person's own key and, when `apply` is set, turns their digest off. The only thing a token can do. It runs as the system role
 * because the person is not signed in (the token is the proof); the key is read here and nowhere else a person's request reaches. An unknown person, a
 * wrong signature and a malformed token all answer the same, so the route says nothing about who has an account.
 */
async function checkToken(ctx: PluginContext, token: string, apply: boolean): Promise<TokenCheck> {
  const parsed = parseDigestToken(token);
  if (!parsed) return { state: 'invalid' };
  return ctx.db.system(async (tx) => {
    const row = (await tx.query<{ enabled: boolean; unsubscribe_key: string; workspace_id: string }>(
      'SELECT enabled, unsubscribe_key, workspace_id FROM app.notification_digest WHERE person_id = $1::uuid FOR UPDATE',
      [parsed.personId],
    )).rows[0];
    if (!row || !digestMacMatches(row.unsubscribe_key, parsed.personId, parsed.mac)) return { state: 'invalid' } as const;
    if (!apply || !row.enabled) return { state: row.enabled ? 'on' : 'off', changed: false } as const;
    await tx.query('UPDATE app.notification_digest SET enabled = false, updated_at = now() WHERE person_id = $1::uuid', [parsed.personId]);
    await ctx.audit.emit(
      tx,
      NotificationsDigestUnsubscribedEvent.parse({ type: 'notifications.digest.unsubscribed', schemaVersion: 1, workspaceId: row.workspace_id, personId: parsed.personId, via: 'link' }),
    );
    return { state: 'off', changed: true } as const;
  });
}

/** Reads what the program sent with the one-click POST (`List-Unsubscribe=One-Click`) and ignores it: at most 4 KB are read, the body decides nothing. */
async function drain(req: HttpRequest): Promise<void> {
  let seen = 0;
  if (!req.stream) return;
  for await (const chunk of req.stream) {
    seen += chunk.length;
    if (seen > 4096) throw new HttpError(413, 'validation_failed', 'That request is too large');
  }
}

/**
 * The email digest's routes: the person's settings (on or off, how long away) and the unsubscribe link at the foot of every digest (docs/plugins/notifications.md).
 * The link needs no sign-in. `GET` shows a page with one button and changes nothing (mail scanners and link previews open links); `POST` turns the digest off
 * for the person the token names, the way RFC 8058 one-click unsubscribe asks mail programs to do it.
 */
export function registerDigestRoutes(ctx: PluginContext): void {
  ctx.http.route({
    ...getDigestSettingsRoute,
    schema: { response: GetDigestSettingsResponse },
    handler: route(async (_req, tx) => json(GetDigestSettingsResponse.parse(await settingsOf(tx, await callerPerson(tx))))),
  });

  ctx.http.route({
    ...putDigestSettingsRoute,
    rateLimit: { limit: 30, windowMs: 60_000 },
    schema: { body: PutDigestSettingsRequest, response: PutDigestSettingsResponse },
    handler: route(async (req, tx) => {
      const body = PutDigestSettingsRequest.parse(req.body);
      const person = await callerPerson(tx);
      const before = (await settingsOf(tx, person)).enabled;
      await tx.query(
        `INSERT INTO app.notification_digest (person_id, workspace_id, enabled, delay_minutes) VALUES ($1::uuid, app.workspace_id(), $2, $3)
         ON CONFLICT (person_id) DO UPDATE SET enabled = EXCLUDED.enabled, delay_minutes = EXCLUDED.delay_minutes, updated_at = now()`,
        [person, body.enabled, body.delayMinutes],
      );
      if (before && !body.enabled) {
        await ctx.audit.emit(
          tx,
          NotificationsDigestUnsubscribedEvent.parse({ type: 'notifications.digest.unsubscribed', schemaVersion: 1, workspaceId: tx.actor.workspaceId, personId: person, via: 'settings' }),
        );
      }
      return json(PutDigestSettingsResponse.parse(await settingsOf(tx, person)));
    }),
  });

  const accountUrl = `${ctx.runtime.publicUrl}/account#${ACCOUNT_ANCHOR}`;
  // Both routes count per client address, whatever session cookie the request carries: the token is the only credential here.
  const open = { public: true, rateLimit: { limit: 30, windowMs: 60_000 }, rateLimitBy: 'address' } as const;

  ctx.http.route({
    ...digestUnsubscribePageRoute,
    ...open,
    handler: async (req): Promise<HttpResponse> => {
      const check = await checkToken(ctx, req.params['token'] ?? '', false);
      if (check.state === 'invalid') return invalidPage();
      return check.state === 'on' ? stopPage() : donePage(accountUrl);
    },
  });

  ctx.http.route({
    ...digestUnsubscribeRoute,
    ...open,
    // A mail program's POST has no session and no CSRF token; the signed token in the path is what authorises it, and all it can do is switch the digest off.
    csrfExempt: true,
    rawBody: true,
    handler: async (req): Promise<HttpResponse> => {
      await drain(req);
      const check = await checkToken(ctx, req.params['token'] ?? '', true);
      const wantsPage = (req.headers['accept'] ?? '').includes('text/html');
      if (check.state === 'invalid') {
        return wantsPage ? invalidPage() : { status: 404, body: { error: { code: 'not_found', message: 'This link is not valid' } } };
      }
      return wantsPage ? donePage(accountUrl) : { status: 200, body: { unsubscribed: true } };
    },
  });
}
