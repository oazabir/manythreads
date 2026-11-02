import { enqueue } from '@manythreads/kernel';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DIGEST_QUEUE, digestTuning } from '../src/digest-job.ts';
import { createWorld, drained, ensureChannels, eventually, personas, type ApiResult, type Persona, type World } from './world.ts';

const { nadia, omar, rafi, sameera, tariq, priya } = personas;

// P14-09b: the digest job under failure. One bad row, one failing audit write, one hung mail server, a restart of the heartbeat data: none of them may cost
// another person their digest, send one twice, or write "sent" for mail that never left. Also the scale rules: only people who are away are read, and a
// run that stops at its cap carries on after the last person it reached.

let skewMs = 10 * 60_000;
const clock = (): Date => new Date(Date.now() + skewMs);

let w: World;
beforeAll(async () => {
  w = await createWorld({ now: clock });
  await ensureChannels(w);
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const ok = <T>(res: ApiResult<T>, status = 200): T => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body;
};
const sql = <T extends Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T[]> => w.system(async (tx) => (await tx.query<T>(text, values)).rows);
const owner = async (text: string): Promise<void> => {
  const client = new pg.Client({ connectionString: w.server.db.ownerUrl });
  await client.connect();
  try {
    await client.query(text);
  } finally {
    await client.end();
  }
};
const mails = (who: Persona) => w.server.mailer.to(who.email);
const watermark = async (who: Persona): Promise<Date | null> => (await sql<{ last_digest_at: Date | null }>('SELECT last_digest_at FROM app.notification_digest WHERE person_id = $1', [who.personId]))[0]?.last_digest_at ?? null;
const sentEvents = (who: Persona) => sql("SELECT 1 FROM app.events WHERE type = 'notifications.digest.sent' AND payload->>'personId' = $1", [who.personId]);
const logLines = (needle: string): string[] => w.server.logs.filter((l) => l.includes(needle));

const runDigest = async (): Promise<void> => {
  const id = await w.system(async (tx) => (await enqueue(tx, DIGEST_QUEUE, {})).id);
  await eventually(async () => ((await sql<{ state: string }>('SELECT state FROM app.jobs WHERE id = $1', [id]))[0]?.state === 'done' ? true : undefined), 30_000, 'the digest job');
};

/** A direct message from Nadia to `to` that is unread, and a way to reach the message itself. */
const dmTo = async (to: Persona, text: string): Promise<{ channelId: string; messageId: string }> => {
  const res = await w.call<{ dm: { channel: { id: string } } }>(nadia, 'POST', '/api/dms', { personIds: [to.personId] });
  expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
  return { channelId: res.body.dm.channel.id, messageId: await post(res.body.dm.channel.id, text) };
};
const post = async (channelId: string, body: string): Promise<string> =>
  ok(await w.call<{ id: string }>(nadia, 'POST', `/api/channels/${channelId}/messages`, { channelId, body, threadRootId: null }), 201).id;

/** Starts a person from scratch: nothing unread, no digest history, no heartbeat, no mail kept. */
const reset = async (...people: Persona[]): Promise<void> => {
  for (const who of people) {
    ok(await w.call(who, 'POST', '/api/notifications/mark-read', { all: true }));
    await sql('DELETE FROM app.notification_digest WHERE person_id = $1', [who.personId]);
    await sql('DELETE FROM app.presence WHERE person_id = $1', [who.personId]);
  }
  await drained(w);
  w.server.mailer.clear();
};

afterEach(async () => {
  await owner('DROP TRIGGER IF EXISTS fail_digest_audit ON app.events; DROP TRIGGER IF EXISTS fail_digest_claim ON app.notification_digest; DROP FUNCTION IF EXISTS app.fail_digest_fault()');
  Object.defineProperty(w.server.mailer, 'configured', { value: undefined, configurable: true, writable: true });
  digestTuning.batch = 200;
  digestTuning.maxRounds = 5;
  digestTuning.sendTimeoutMs = 45_000;
});

describe('a server with no mail server set up', () => {
  it('sends nothing, moves no watermark, writes no "sent" record, and says so once for the whole process', async () => {
    await dmTo(omar, 'while nothing can be sent');
    await dmTo(rafi, 'also while nothing can be sent');
    await drained(w);
    Object.defineProperty(w.server.mailer, 'configured', { value: false, configurable: true, writable: true });
    await runDigest();
    await runDigest();
    await runDigest();
    expect(mails(omar)).toHaveLength(0);
    expect(await watermark(omar)).toBeNull();
    expect(await watermark(rafi)).toBeNull();
    expect(await sentEvents(omar)).toHaveLength(0);
    const said = logLines('no mail server is set up');
    expect(said).toHaveLength(1);
    expect(said.join('\n')).not.toContain('@');
    // the settings say so, too
    const settings = ok(await w.call<{ mailConfigured: boolean; emailAvailable: boolean }>(omar, 'GET', '/api/notifications/digest'));
    expect(settings).toMatchObject({ mailConfigured: false, emailAvailable: true });
  });

  it('delivers the same digests once mail is set up: nothing was lost while it was not', async () => {
    expect(ok(await w.call<{ mailConfigured: boolean }>(omar, 'GET', '/api/notifications/digest')).mailConfigured).toBe(true);
    // One person's audit write fails (a database trigger stands in for any failure after the mail has gone out).
    await owner(`CREATE FUNCTION app.fail_digest_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$;
      CREATE TRIGGER fail_digest_audit BEFORE INSERT ON app.events FOR EACH ROW WHEN (NEW.type = 'notifications.digest.sent' AND NEW.payload->>'personId' = '${omar.personId}') EXECUTE FUNCTION app.fail_digest_fault()`);
    await runDigest();
    expect(mails(omar)).toHaveLength(1);
    expect(mails(rafi)).toHaveLength(1);
    // the mail went out, so the claim stays: no second mail, ever, for the same things
    expect(await watermark(omar)).not.toBeNull();
    expect(await sentEvents(omar)).toHaveLength(0);
    expect(await sentEvents(rafi)).toHaveLength(1);
    const warned = logLines('was sent but its record could not be written');
    expect(warned.length).toBeGreaterThanOrEqual(1);
    expect(warned.join('\n')).not.toContain(omar.email);
    await runDigest();
    await runDigest();
    expect(mails(omar)).toHaveLength(1);
  });
});

describe('one bad row never costs another person their digest', () => {
  it('a person whose claim fails is skipped and tried again; the others in the same round are mailed', async () => {
    await reset(sameera, tariq);
    await dmTo(sameera, 'for the person whose claim fails');
    await dmTo(tariq, 'for the person after them');
    await drained(w);
    await owner(`CREATE FUNCTION app.fail_digest_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$;
      CREATE TRIGGER fail_digest_claim BEFORE UPDATE ON app.notification_digest FOR EACH ROW WHEN (OLD.person_id = '${sameera.personId}') EXECUTE FUNCTION app.fail_digest_fault()`);
    await runDigest();
    expect(mails(sameera)).toHaveLength(0);
    expect(mails(tariq)).toHaveLength(1);
    expect(await watermark(sameera)).toBeNull();
    expect(logLines('could not be prepared').length).toBeGreaterThanOrEqual(1);
    // the fault is gone: the next run tries again and succeeds
    await owner('DROP TRIGGER fail_digest_claim ON app.notification_digest');
    await runDigest();
    expect(mails(sameera)).toHaveLength(1);
    expect(mails(tariq)).toHaveLength(1);
  });

  it('a mail server that never answers is given up on, the claim is put back, and the next person is still mailed', async () => {
    await reset(priya, omar);
    await dmTo(priya, 'for the person the mail server hangs on');
    await dmTo(omar, 'for the person after them');
    await drained(w);
    digestTuning.sendTimeoutMs = 300;
    const mailer = w.server.mailer;
    const original = mailer.send.bind(mailer);
    (mailer as { send: typeof mailer.send }).send = (message) => (message.to === priya.email ? new Promise<void>(() => undefined) : original(message));
    try {
      await runDigest();
      expect(mails(omar)).toHaveLength(1);
      expect(mails(priya)).toHaveLength(0);
      expect(await watermark(priya)).toBeNull();
      expect(logLines('could not be sent').join('\n')).not.toContain(priya.email);
    } finally {
      (mailer as { send: typeof mailer.send }).send = original;
    }
    await runDigest();
    expect(mails(priya)).toHaveLength(1);
  });
});

describe('the words of the mail are read when it is made', () => {
  it('shows an edited message as it is now and leaves out a deleted one', async () => {
    await reset(omar);
    const first = await dmTo(omar, 'the words as first written');
    const gone = { channelId: first.channelId, messageId: await post(first.channelId, 'a message that is deleted again') };
    await drained(w);
    ok(await w.call(nadia, 'PATCH', `/api/channels/${first.channelId}/messages/${first.messageId}`, { body: 'the words after an edit' }));
    ok(await w.call(nadia, 'DELETE', `/api/channels/${gone.channelId}/messages/${gone.messageId}`));
    await drained(w);
    await runDigest();
    expect(mails(omar)).toHaveLength(1);
    const mail = mails(omar)[0]!;
    expect(mail.text).toContain('the words after an edit');
    expect(mail.text).not.toContain('as first written');
    expect(mail.text).not.toContain('deleted again');
    expect(mail.subject).toBe('1 new message for you');
  });
});

describe('after a restart of the heartbeat data', () => {
  it('waits five minutes: a person is not called away just because the table of heartbeats was emptied', async () => {
    await reset(rafi);
    await dmTo(rafi, 'written just after a crash');
    await drained(w);
    const saved = skewMs;
    skewMs = 0;
    try {
      await sql('DELETE FROM app.presence_epoch');                           // what a crash does to an UNLOGGED table
      await runDigest();
      expect(mails(rafi)).toHaveLength(0);
      expect(await watermark(rafi)).toBeNull();
      expect(logLines('heartbeat data is new').length).toBeGreaterThanOrEqual(1);
      skewMs = 6 * 60_000;
      await runDigest();
      expect(mails(rafi)).toHaveLength(1);
    } finally {
      skewMs = saved;
    }
  });
});

describe('who is read, and in what order', () => {
  const byId = [omar, rafi, sameera, tariq, priya].sort((a, b) => a.personId.localeCompare(b.personId));

  it('never reads people who are online: an away person after them is reached in the very first round', async () => {
    const [online, away] = byId as [Persona, Persona];
    await reset(online, away);
    await dmTo(online, 'for somebody at their desk');
    await dmTo(away, 'for somebody away');
    await drained(w);
    ok(await w.call(online, 'POST', '/api/presence', {}));
    digestTuning.batch = 1;
    digestTuning.maxRounds = 1;
    await runDigest();
    expect(mails(online)).toHaveLength(0);
    expect(mails(away)).toHaveLength(1);
    digestTuning.batch = 200;
    digestTuning.maxRounds = 5;
    await runDigest();                                                       // lets the cursor wrap round
  });

  it('carries on after the last person a capped run reached, so nobody with a higher id is starved', async () => {
    await reset(...byId);
    // the first three have unread items the settings no longer allow (they stay candidates for ever); the last two have real ones
    for (const [i, who] of byId.entries()) {
      const { channelId } = await dmTo(who, `unread number ${i}`);
      if (i < 3) {
        await drained(w);
        ok(await w.call(who, 'PUT', `/api/notifications/levels/${channelId}`, { level: 'nothing' }));
      }
    }
    await drained(w);
    digestTuning.batch = 2;
    digestTuning.maxRounds = 1;
    await runDigest();                                                       // sees person 0 and 1
    expect(w.server.mailer.sent).toHaveLength(0);
    await runDigest();                                                       // carries on: person 2 and 3
    expect(mails(byId[3]!)).toHaveLength(1);
    expect(mails(byId[4]!)).toHaveLength(0);
    await runDigest();                                                       // person 4
    expect(mails(byId[4]!)).toHaveLength(1);
    digestTuning.batch = 200;
    digestTuning.maxRounds = 5;
    await runDigest();
    for (const who of byId.slice(0, 3)) expect(mails(who), who.email).toHaveLength(0);
  });
});
