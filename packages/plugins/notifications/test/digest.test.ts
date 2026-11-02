import { enqueue } from '@manythreads/kernel';
import { GetDigestSettingsResponse, PutDigestSettingsResponse } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DIGEST_QUEUE } from '../src/digest-job.ts';
import { createWorld, drained, ensureChannels, eventually, personas, type ApiResult, type Persona, type World } from './world.ts';

const { omar, nadia, rafi, sameera, tariq, priya, lena } = personas;

// P14-09: the email digest. A person who has been away for their delay (default an hour) and still has unread mentions, replies or direct messages
// gets ONE mail listing them, through the system mailer, with a signed one-click unsubscribe link. Nothing the app would not have told them about is in it.

// The clock the server reads (`ctx.runtime.now`): a test moves it forward to let people be "away" without waiting. The heartbeat and the notifications are
// stamped by the database's own clock, so moving this one forward is the same as time passing.
let skewMs = 0;
const clock = (): Date => new Date(Date.now() + skewMs);
const MINUTE = 60_000;
const later = (minutes: number): void => {
  skewMs += minutes * MINUTE;
};

let w: World;
let dev = '';
beforeAll(async () => {
  w = await createWorld({ now: clock });
  await ensureChannels(w);
  dev = await w.channelId('engineering', 'dev');
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const ok = <T>(res: ApiResult<T>, status = 200): T => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body;
};
const post = async (who: Persona, channelId: string, body: string): Promise<string> =>
  ok(await w.call<{ id: string }>(who, 'POST', `/api/channels/${channelId}/messages`, { channelId, body, threadRootId: null }), 201).id;
const dm = async (from: Persona, to: Persona): Promise<string> => {
  const res = await w.call<{ dm: { channel: { id: string } } }>(from, 'POST', '/api/dms', { personIds: [to.personId] });
  expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
  return res.body.dm.channel.id;
};
const mails = (who: Persona) => w.server.mailer.to(who.email);
const sql = <T extends Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T[]> => w.system(async (tx) => (await tx.query<T>(text, values)).rows);

/** Runs the digest job once and waits for it to finish (the cron would do it within a minute). */
const runDigest = async (): Promise<void> => {
  const id = await w.system(async (tx) => (await enqueue(tx, DIGEST_QUEUE, {})).id);
  await eventually(async () => ((await sql<{ state: string }>('SELECT state FROM app.jobs WHERE id = $1', [id]))[0]?.state === 'done' ? true : undefined), 30_000, 'the digest job');
};
const digestEvents = (type: string, who: Persona): Promise<Array<{ payload: Record<string, unknown> }>> =>
  sql<{ payload: Record<string, unknown> }>('SELECT payload FROM app.events WHERE type = $1 AND payload->>\'personId\' = $2 ORDER BY occurred_at', [type, who.personId]);
const watermark = async (who: Persona): Promise<Date | null> => (await sql<{ last_digest_at: Date | null }>('SELECT last_digest_at FROM app.notification_digest WHERE person_id = $1', [who.personId]))[0]?.last_digest_at ?? null;
/**
 * Lets `minutes` pass for one person on the database's clock, which a test cannot move: their last digest and everything they were notified of become
 * that much older, so what was in the last digest stays before it.
 */
const backdate = async (who: Persona, minutes: number): Promise<void> => {
  await sql('UPDATE app.notification_digest SET last_digest_at = last_digest_at - make_interval(mins => $2::int) WHERE person_id = $1', [who.personId, minutes]);
  await sql('UPDATE app.notifications SET created_at = created_at - make_interval(mins => $2::int) WHERE person_id = $1', [who.personId, minutes]);
};
const tokenIn =(text: string): string => /\/api\/notifications\/digest\/unsubscribe\/(v1\.[0-9a-f-]+\.[A-Za-z0-9_-]+)/.exec(text)?.[1] ?? '';

describe('who gets a digest, and when', () => {
  it('sends nothing to a person who is at their desk', async () => {
    ok(await w.call(rafi, 'POST', '/api/presence', {}));
    await post(nadia, dev, '@rafi do you have a minute for the release?');
    await drained(w);
    await runDigest();
    expect(mails(rafi)).toHaveLength(0);
  });

  it('sends one mail once they have been away for their delay, with the one-click headers, and never a second for the same things', async () => {
    later(61);
    await runDigest();
    expect(mails(rafi)).toHaveLength(1);
    const mail = mails(rafi)[0]!;
    expect(mail.subject).toBe('1 unread message is waiting for you');
    expect(mail.text).toContain('#dev');
    expect(mail.text).toContain('do you have a minute for the release?');
    expect(mail.text).toContain(`/open?channel=${dev}&message=`);
    expect(mail.headers?.['List-Unsubscribe']).toMatch(/^<http:\/\/localhost:3000\/api\/notifications\/digest\/unsubscribe\/v1\./);
    expect(mail.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    // nobody else had anything unread, so nobody else got a mail
    for (const p of [omar, nadia, sameera, tariq, priya, lena]) expect(mails(p), p.email).toHaveLength(0);
    // the event has counts and no text
    const [event] = await digestEvents('notifications.digest.sent', rafi);
    expect(event?.payload).toMatchObject({ itemCount: 1, shownCount: 1, channelCount: 1 });
    expect(JSON.stringify(event?.payload)).not.toContain('minute');
    // and the audit log has it, content-blind
    const audit = await eventually(
      async () => {
        const rows = await sql<{ reason: string; category: string }>("SELECT reason, category FROM app.audit_events WHERE action = 'digest.sent' AND target_id = $1", [rafi.personId]);
        return rows.length === 1 ? rows : undefined;
      },
      20_000,
      'the audit row',
    );
    expect(audit[0]).toEqual({ reason: '1 item listed of 1 unread, in 1 conversation', category: 'system' });

    await runDigest();
    await runDigest();
    expect(mails(rafi)).toHaveLength(1);
  });

  it('waits out the delay before the next digest and then lists only what came since', async () => {
    await dm(nadia, rafi).then((c) => post(nadia, c, 'a second note, in private'));
    await drained(w);
    await runDigest();
    expect(mails(rafi)).toHaveLength(1);                                       // within the hour: not yet
    await backdate(rafi, 61);
    await runDigest();
    expect(mails(rafi)).toHaveLength(2);
    const text = mails(rafi)[1]!.text;
    expect(text).toContain('a second note, in private');
    expect(text).toContain('Direct message');
    expect(text).not.toContain('do you have a minute for the release?');       // the first digest already had it
  });

  it('sends nothing when everything is read, or when the private channel was left', async () => {
    await post(nadia, dev, '@priya please look at the public notes');
    await drained(w);
    ok(await w.call(priya, 'POST', '/api/notifications/mark-read', { all: true }));
    const secret = ok(await w.call<{ channel: { id: string } }>(omar, 'POST', '/api/teams/engineering/channels', { name: 'digest-secret', private: true }), 201).channel.id;
    ok(await w.call(omar, 'POST', `/api/channels/${secret}/members`, { personId: nadia.personId }));
    ok(await w.call(omar, 'POST', `/api/channels/${secret}/members`, { personId: priya.personId }));
    await post(nadia, secret, '@priya the launch date is a secret');
    await drained(w);
    // priya leaves behind a notification for a channel she can no longer read (removed straight in the database, as if the event had been lost)
    await sql('DELETE FROM app.channel_members WHERE channel_id = $1 AND person_id = $2', [secret, priya.personId]);
    later(61);
    await runDigest();
    expect(mails(priya)).toHaveLength(0);
    // given access back, the same unread item is listed
    ok(await w.call(omar, 'POST', `/api/channels/${secret}/members`, { personId: priya.personId }));
    await runDigest();
    expect(mails(priya)).toHaveLength(1);
    expect(mails(priya)[0]!.text).toContain('the launch date is a secret');
    expect(mails(priya)[0]!.text).not.toContain('public notes');               // read in the app, so not repeated
  });

  it('sends nothing while Do not disturb is on, and sends what was held once it is off; a mailer that fails is tried again', async () => {
    ok(await w.call(tariq, 'PUT', '/api/presence/dnd', { enabled: true }));
    const channel = await dm(nadia, tariq);
    await post(nadia, channel, 'held while you were away');
    await drained(w);
    later(61);
    await runDigest();
    expect(mails(tariq)).toHaveLength(0);

    ok(await w.call(tariq, 'PUT', '/api/presence/dnd', { enabled: false }));
    await eventually(async () => ((await sql('SELECT 1 FROM app.notifications WHERE person_id = $1 AND held_at IS NULL', [tariq.personId])).length > 0 ? true : undefined), 20_000, 'the held message to arrive');
    await drained(w);

    const mailer = w.server.mailer;
    const original = mailer.send.bind(mailer);
    let refused = 0;
    (mailer as { send: typeof mailer.send }).send = (message) => {
      if (message.to === tariq.email) {
        refused += 1;
        return Promise.reject(new Error('mail server is down'));
      }
      return original(message);
    };
    try {
      later(61);
      await runDigest();
      expect(refused).toBe(1);
      expect(mails(tariq)).toHaveLength(0);
      expect(await watermark(tariq)).toBeNull();                               // given back: the next run tries again
    } finally {
      (mailer as { send: typeof mailer.send }).send = original;
    }
    await runDigest();
    expect(mails(tariq)).toHaveLength(1);
    expect(mails(tariq)[0]!.text).toContain('held while you were away');
  });

  it('lists only what would still tell the person in the app: a channel set to Nothing after the fact is left out', async () => {
    const channel = await dm(nadia, sameera);
    await post(nadia, channel, 'this one used to notify');
    await drained(w);
    ok(await w.call(sameera, 'PUT', `/api/notifications/levels/${channel}`, { level: 'nothing' }));
    later(61);
    await runDigest();
    expect(mails(sameera)).toHaveLength(0);
  });

  it('sends nothing to a person without a verified email address, and lists at most 10 items with "and N more"', async () => {
    const channel = await dm(nadia, omar);
    for (let i = 1; i <= 12; i += 1) await post(nadia, channel, `note number ${i}`);
    await drained(w);
    await sql('UPDATE app.person_emails SET verified_at = NULL WHERE person_id = $1', [omar.personId]);
    expect(GetDigestSettingsResponse.parse(ok(await w.call(omar, 'GET', '/api/notifications/digest'))).emailAvailable).toBe(false);
    later(61);
    await runDigest();
    expect(mails(omar)).toHaveLength(0);

    await sql('UPDATE app.person_emails SET verified_at = now() WHERE person_id = $1', [omar.personId]);
    expect(GetDigestSettingsResponse.parse(ok(await w.call(omar, 'GET', '/api/notifications/digest'))).emailAvailable).toBe(true);
    await runDigest();
    expect(mails(omar)).toHaveLength(1);
    const mail = mails(omar)[0]!;
    expect(mail.subject).toBe('12 unread messages are waiting for you');
    expect(mail.text).toContain('and 2 more.');
    expect(mail.text.match(/\/open\?channel=/g)).toHaveLength(10);
    expect(await digestEvents('notifications.digest.sent', omar)).toHaveLength(1);
    expect((await digestEvents('notifications.digest.sent', omar))[0]?.payload).toMatchObject({ itemCount: 12, shownCount: 10 });
  });
});

describe('the settings', () => {
  it('start on, at an hour, and are changed with a delay from 30 minutes to 24 hours', async () => {
    const first = GetDigestSettingsResponse.parse(ok(await w.call(lena, 'GET', '/api/notifications/digest')));
    expect(first).toMatchObject({ enabled: true, delayMinutes: 60, emailAvailable: true, lastSentAt: null });
    const saved = PutDigestSettingsResponse.parse(ok(await w.call(lena, 'PUT', '/api/notifications/digest', { enabled: true, delayMinutes: 240 })));
    expect(saved.delayMinutes).toBe(240);
    expect(GetDigestSettingsResponse.parse(ok(await w.call(lena, 'GET', '/api/notifications/digest'))).delayMinutes).toBe(240);
    for (const delayMinutes of [29, 1441, 0, -5, 61.5]) {
      expect((await w.call(lena, 'PUT', '/api/notifications/digest', { enabled: true, delayMinutes })).status, String(delayMinutes)).toBe(400);
    }
    expect((await w.call(lena, 'PUT', '/api/notifications/digest', { enabled: true, delayMinutes: 60, extra: 1 })).status).toBe(400);
    expect((await w.call(null, 'GET', '/api/notifications/digest')).status).toBe(401);
  });

  it('switching it off is recorded once, without text, and switching it off again records nothing more', async () => {
    ok(await w.call(lena, 'PUT', '/api/notifications/digest', { enabled: false, delayMinutes: 240 }));
    ok(await w.call(lena, 'PUT', '/api/notifications/digest', { enabled: false, delayMinutes: 120 }));
    const events = await digestEvents('notifications.digest.unsubscribed', lena);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ via: 'settings' });
  });
});

describe('the one-click unsubscribe link', () => {
  const base = (): string => w.server.url;
  const path = (token: string): string => `/api/notifications/digest/unsubscribe/${token}`;
  const get = (token: string): Promise<Response> => fetch(`${base()}${path(token)}`);
  const postForm = (token: string, accept = '*/*'): Promise<Response> =>
    fetch(`${base()}${path(token)}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept }, body: 'List-Unsubscribe=One-Click' });
  const enabledOf = async (who: Persona): Promise<boolean | undefined> => (await sql<{ enabled: boolean }>('SELECT enabled FROM app.notification_digest WHERE person_id = $1', [who.personId]))[0]?.enabled;
  let token = '';

  it('shows a page on a visit and changes nothing until the button is pressed', async () => {
    token = tokenIn(mails(rafi)[1]!.text);
    expect(token).not.toBe('');
    const res = await get(token);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    expect(html).toContain('Stop these emails');
    expect(html).not.toContain('<script');
    expect(await enabledOf(rafi)).toBe(true);
  });

  it('turns the digest off for that one person on a POST, with no sign-in, and again harmlessly', async () => {
    const res = await postForm(token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ unsubscribed: true });
    expect(await enabledOf(rafi)).toBe(false);
    expect((await postForm(token)).status).toBe(200);
    expect(await digestEvents('notifications.digest.unsubscribed', rafi)).toHaveLength(1);
    expect((await digestEvents('notifications.digest.unsubscribed', rafi))[0]?.payload).toMatchObject({ via: 'link' });
    // nobody else was touched
    for (const p of [omar, priya, tariq, sameera]) expect(await enabledOf(p), p.email).not.toBe(false);
    const page = await get(token);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('You will no longer get these emails');
    expect(html).toContain('Turn them back on');
    expect(html).toContain('/account#' + 'acc-notifications');
    const browser = await postForm(token, 'text/html');
    expect(await browser.text()).toContain('You will no longer get these emails');
  });

  it('says the same "not valid" for a changed token, another person\'s name on it, and an unknown person', async () => {
    const [, id, mac] = token.split('.') as [string, string, string];
    const flipped = `v1.${id}.${mac.slice(0, -1)}${mac.endsWith('A') ? 'B' : 'A'}`;
    const stranger = `v1.${priya.personId}.${mac}`;
    const unknown = `v1.01a0fb83-ada6-7efa-8bc6-50dade5f5784.${mac}`;
    for (const bad of [flipped, stranger, unknown, 'nonsense', `v1.${id}`]) {
      expect((await get(bad)).status, bad).toBe(404);
      expect((await postForm(bad)).status, bad).toBe(404);
    }
    expect(await enabledOf(priya)).not.toBe(false);
  });

  it('sends nothing to someone who unsubscribed, and turning it back on does not send what piled up, only what is new', async () => {
    const channel = await dm(nadia, rafi);
    await post(nadia, channel, 'written while it was off');
    await drained(w);
    await backdate(rafi, 240);
    const before = mails(rafi).length;
    await runDigest();
    expect(mails(rafi)).toHaveLength(before);

    ok(await w.call(rafi, 'PUT', '/api/notifications/digest', { enabled: true, delayMinutes: 120 }));
    expect(await watermark(rafi)).not.toBeNull();
    await runDigest();
    expect(mails(rafi)).toHaveLength(before);                                  // the pile is not mailed
    await post(nadia, channel, 'written after it was back on');
    await drained(w);
    await backdate(rafi, 121);
    await runDigest();
    expect(mails(rafi)).toHaveLength(before + 1);
    const text = mails(rafi).at(-1)!.text;
    expect(text).toContain('written after it was back on');
    expect(text).not.toContain('written while it was off');
  });

  it('keeps the link good as long as the person exists: a month later it still works', async () => {
    expect(await enabledOf(rafi)).toBe(true);
    later(31 * 24 * 60);
    expect((await postForm(token)).status).toBe(200);
    expect(await enabledOf(rafi)).toBe(false);
  });
});
