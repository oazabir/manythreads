import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eventually, ensureChannels } from '../../channels/test/world.ts';
import { createWorld, personas, type FilesWorld, type Persona } from '../../files/test/world.ts';
import { resetDropLimits } from '../src/upload.ts';
import { sampleEml } from './zipkit.ts';

// P8-19 through the real server: mail sent to a team's address becomes an inbox item. The subject is the title, the attachments become items of their own, no bot
// runs for the message, and who is let in depends on what the mail transport vouched for (SPF/DKIM, in the query of the delivery) and on who the sender is among
// the workspace's people. A header written inside the message proves nothing.

const { omar, nadia, sameera, lena, tariq } = personas;
vi.setConfig({ testTimeout: 120_000 });

let world: FilesWorld;
let since = new Date(0);
let serial = 0;

interface Item {
  id: string;
  origin: string;
  state: string;
  kind: string;
  name: string;
  droppedBy: string | null;
  droppedByName: string | null;
  holdReason: string | null;
  parentId: string | null;
  filedPaths: string[];
  sender: string | null;
  senderCheck: string | null;
}
interface Delivery {
  teamSlug: string;
  status: 'received' | 'duplicate' | 'ignored';
  itemId: string | null;
  reason: string | null;
}
interface Delivered {
  messageId: string | null;
  authentication: 'pass' | 'fail';
  deliveries: Delivery[];
}
interface EmailInfo {
  address: string | null;
  connection: { slug: string; name: string } | null;
  reason: string | null;
  allowedSenders: string[];
  rule: string;
  canSetUp: boolean;
}

const headersOf = (who: Persona): Record<string, string> => ({ 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: who.actorId, workspaceId: who.workspaceId }) });
const ADDRESS = (team: string): string => `inbox+${team}@mail.manythreads.invalid`;

interface MailOptions {
  from?: string;
  to?: string[];
  cc?: string[];
  subject?: string;
  messageId?: string | null;
  text?: string;
  attachment?: boolean;
  extra?: string[];
}
/** A plain message, built so that two calls never give the same bytes. */
function mail(o: MailOptions = {}): string {
  serial += 1;
  const messageId = o.messageId === undefined ? `<door-${String(serial)}@sender.example>` : o.messageId;
  const lines = [
    `From: ${o.from ?? 'nadia@kahf.example'}`,
    `To: ${(o.to ?? [ADDRESS('engineering')]).join(', ')}`,
    ...(o.cc ? [`Cc: ${o.cc.join(', ')}`] : []),
    `Subject: ${o.subject ?? `Standup notes ${String(serial)}`}`,
    ...(messageId === null ? [] : [`Message-ID: ${messageId}`]),
    ...(o.extra ?? []),
    'MIME-Version: 1.0',
  ];
  const text = o.text ?? `The deploy window moved to Thursday. Reference number ${String(serial)}.`;
  if (!o.attachment) return [...lines, 'Content-Type: text/plain; charset=utf-8', '', text, ''].join('\r\n');
  return [
    ...lines,
    'Content-Type: multipart/mixed; boundary="b1"',
    '',
    '--b1',
    'Content-Type: text/plain; charset=utf-8',
    '',
    text,
    '--b1',
    'Content-Type: application/pdf; name="plan.pdf"',
    'Content-Disposition: attachment; filename="plan.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(`%PDF-1.4 plan ${String(serial)}`).toString('base64'),
    '--b1--',
    '',
  ].join('\r\n');
}

const deliver = async (who: Persona | null, message: string | Uint8Array, query = 'spf=pass&dkim=pass', mailbox = 'inbox'): Promise<{ status: number; body: Delivered & { error?: { message: string } } }> => {
  const res = await fetch(`${world.server.url}/api/workspace/inbox-mail/${mailbox}${query ? `?${query}` : ''}`, {
    method: 'POST',
    headers: { ...(who ? headersOf(who) : {}), 'content-type': 'message/rfc822' },
    body: (typeof message === 'string' ? Buffer.from(message) : message) as unknown as RequestInit['body'],
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const getItem = async (who: Persona, id: string, team = 'engineering'): Promise<Item> => (await world.call<{ item: Item }>(who, 'GET', `/api/teams/${team}/inbox/items/${id}`)).body.item;
const settle = (id: string, wanted: string[]): Promise<Item> =>
  eventually(async () => {
    const it = await getItem(omar, id);
    return wanted.includes(it.state) ? it : false;
  }, 60_000, `the item to settle (${wanted.join('/')})`);
const repoFile = async (path: string): Promise<string> => {
  const res = await world.call<{ content: string }>(omar, 'GET', `/api/teams/engineering/repo/blob?path=${encodeURIComponent(path)}`);
  expect(res.status, `${path}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.content;
};
const setTeamMd = async (frontmatter: string): Promise<void> => {
  const res = await world.call(omar, 'POST', '/api/teams/engineering/proposals', { path: 'TEAM.md', op: 'put', content: `---\n${frontmatter}---\n\n# Engineering\n`, title: 'Inbox settings', applyNow: true });
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
};
const emailInfo = async (who: Persona, team = 'engineering'): Promise<{ status: number; body: EmailInfo }> => world.call<EmailInfo>(who, 'GET', `/api/teams/${team}/inbox/email`);
/** Delivers one message to the Engineering inbox and returns its single delivery. */
const deliverOne = async (message: string, query?: string): Promise<{ status: number; delivery: Delivery }> => {
  const res = await deliver(omar, message, query);
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return { status: res.status, delivery: res.body.deliveries[0]! };
};
const withEnv = async (vars: Record<string, string>, fn: () => Promise<void>): Promise<void> => {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

beforeAll(async () => {
  world = await createWorld();
  await ensureChannels(world);
  since = (await world.system((tx) => tx.query<{ now: Date }>('SELECT clock_timestamp() AS now'))).rows[0]!.now;
}, 180_000);

beforeEach(() => {
  resetDropLimits();
});

afterAll(async () => {
  await world?.close();
});

describe('the team address', () => {
  it('is not there until an admin switches the mailbox on; people are told who can', async () => {
    const asMember = await emailInfo(nadia);
    expect(asMember.status).toBe(200);
    expect(asMember.body).toMatchObject({ address: null, connection: null, canSetUp: false });
    expect(asMember.body.reason).toContain('Ask a workspace admin');
    const asAdmin = await emailInfo(omar);
    expect(asAdmin.body).toMatchObject({ address: null, canSetUp: true });
    expect(asAdmin.body.reason).toContain('Switch it on once');
  });

  it('a guest has no team inbox, and nobody off the team reads its address', async () => {
    expect((await emailInfo(lena)).status).toBe(403);
    expect((await emailInfo(sameera)).status).toBeGreaterThanOrEqual(403);
  });

  it('only a workspace admin switches the mailbox on; doing it twice changes nothing', async () => {
    expect((await world.call(nadia, 'POST', '/api/workspace/inbox-mail')).status).toBe(403);
    const first = await world.call<{ connection: { slug: string }; created: boolean; domain: string }>(omar, 'POST', '/api/workspace/inbox-mail');
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({ connection: { slug: 'inbox' }, created: true, domain: 'mail.manythreads.invalid' });
    const again = await world.call<{ created: boolean }>(omar, 'POST', '/api/workspace/inbox-mail');
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
    const rows = await world.system((tx) => tx.query(`SELECT 1 FROM app.connections WHERE kind = 'email' AND slug = 'inbox' AND scope = 'workspace'`));
    expect(rows.rows).toHaveLength(1);
    const audit = await world.system((tx) =>
      tx.query<{ payload: Record<string, unknown> }>(`SELECT payload FROM app.events WHERE type = 'connections.connection.changed' AND occurred_at >= $1 ORDER BY id`, [since]),
    );
    expect(audit.rows.filter((r) => r.payload['slug'] === 'inbox' && r.payload['change'] === 'created')).toHaveLength(1);
  });

  it('is made of the mailbox, the team and the mail domain, and the rule says who is let in', async () => {
    const info = await emailInfo(nadia);
    expect(info.body.address).toBe('inbox+engineering@mail.manythreads.invalid');
    expect(info.body.connection).toMatchObject({ slug: 'inbox' });
    expect(info.body.reason).toBeNull();
    expect(info.body.allowedSenders).toEqual([]);
    expect(info.body.rule).toContain('Mail from people on this team goes straight in');
    expect((await emailInfo(tariq, 'marketing')).body.address).toBe('inbox+marketing@mail.manythreads.invalid');
    await withEnv({ MANYTHREADS_MAIL_DOMAIN: 'Mail.Kahf.Example' }, async () => {
      expect((await emailInfo(nadia)).body.address).toBe('inbox+engineering@mail.kahf.example');
    });
  });
});

describe('delivery', () => {
  it('is for workspace admins and the transport only: a member, or nobody, is refused', async () => {
    expect((await deliver(nadia, mail())).status).toBe(403);
    expect((await deliver(null, mail())).status).toBe(401);
  });

  it('refuses a mailbox that is not switched on, an empty body, junk, a message with no From and one for no team', async () => {
    expect((await deliver(omar, mail(), 'spf=pass', 'nope')).status).toBe(404);
    expect((await deliver(omar, '')).status).toBe(400);
    expect((await deliver(omar, 'this is not an email at all')).status).toBe(400);
    expect((await deliver(omar, mail({ from: '' }).replace(/^From: \r\n/, ''))).status).toBe(400);
    const stranger = await deliver(omar, mail({ to: ['someone@elsewhere.example'] }));
    expect(stranger.status).toBe(400);
    expect(stranger.body.error?.message).toContain('team inbox address');
    expect((await deliver(omar, mail(), 'spf=maybe')).status).toBe(400);
  });

  it('refuses a message over the size cap', async () => {
    await withEnv({ MANYTHREADS_INBOX_MAX_BYTES: '4096' }, async () => {
      const res = await deliver(omar, mail({ text: 'x'.repeat(10_000) }));
      expect(res.status).toBe(413);
    });
  });
});

describe('a message from a person of the team, proved by the sending domain', () => {
  let first: Item;
  let delivery: Delivery;

  it('goes in as an email item: the subject is the title, the sender is credited, and the mail is filed as a Reference', async () => {
    const res = await deliver(omar, mail({ subject: 'Deploy window moves to Thursday', attachment: true }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.authentication).toBe('pass');
    delivery = res.body.deliveries[0]!;
    expect(delivery).toMatchObject({ teamSlug: 'engineering', status: 'received', reason: null });
    first = await settle(delivery.itemId!, ['filed', 'held', 'failed']);
    expect(first).toMatchObject({
      origin: 'email',
      kind: 'eml',
      name: 'Deploy window moves to Thursday',
      state: 'filed',
      sender: 'nadia@kahf.example',
      senderCheck: 'pass',
      droppedByName: 'Nadia',
    });
    expect(first.droppedBy).toBe(nadia.actorId);
    const concept = await repoFile(first.filedPaths[0]!);
    expect(concept).toContain('type: Reference');
    expect(concept).toContain('The deploy window moved to Thursday.');
  });

  it('gives the attachment an item of its own, with the message’s sender and trust', async () => {
    const children = await eventually(async () => {
      const all = (await world.call<{ items: Item[] }>(omar, 'GET', '/api/teams/engineering/inbox/items?limit=200')).body.items;
      const mine = all.filter((i) => i.parentId === first.id);
      return mine.length > 0 ? mine : false;
    }, 30_000, 'the attachment item');
    expect(children.find((c) => c.name === 'plan.pdf')).toMatchObject({ kind: 'pdf', sender: 'nadia@kahf.example', senderCheck: 'pass', droppedBy: nadia.actorId });
  });

  it('is one item however many times the transport delivers it', async () => {
    const message = mail({ messageId: '<same-message@sender.example>' });
    const one = await deliverOne(message);
    expect(one.status).toBe(201);
    const again = await deliverOne(message);
    expect(again.status).toBe(200);
    expect(again.delivery).toMatchObject({ status: 'duplicate', itemId: one.delivery.itemId });
    // the same Message-ID with different bytes is still the same message to this team
    const edited = await deliverOne(mail({ messageId: '<same-message@sender.example>', text: 'A different body entirely.' }));
    expect(edited.delivery).toMatchObject({ status: 'duplicate', itemId: one.delivery.itemId });
  });

  it('starts no bot: no run is made and no claim is recorded for the message', async () => {
    const runs = await world.system((tx) => tx.query(`SELECT 1 FROM app.bot_runs WHERE trigger_type = 'inbox' AND started_at >= $1`, [since]));
    expect(runs.rows).toHaveLength(0);
    const claims = await world.system((tx) => tx.query(`SELECT 1 FROM app.events WHERE type = 'connections.inbox.claimed' AND occurred_at >= $1`, [since]));
    expect(claims.rows).toHaveLength(0);
  });

  it('is read by the same parser as an .eml file dropped by hand', async () => {
    const dropped = await fetch(`${world.server.url}/api/teams/engineering/inbox/items?name=${encodeURIComponent('renewal.eml')}`, {
      method: 'POST',
      headers: { ...headersOf(nadia), 'content-type': 'application/octet-stream' },
      body: Buffer.from(sampleEml()) as unknown as RequestInit['body'],
    });
    expect(dropped.status).toBe(201);
    const byHand = ((await dropped.json()) as { item: Item }).item;
    const forDoor = Buffer.from(sampleEml())
      .toString()
      .replace('To: Support <support@example.com>', `To: ${ADDRESS('engineering')}`)
      .replace('From: =?UTF-8?B?w4lsb2lzZQ==?= <eloise@example.com>', 'From: nadia@kahf.example');
    expect(forDoor).toContain('nadia@kahf.example');
    const viaDoor = (await deliver(omar, forDoor)).body.deliveries[0]!;
    const a = await settle(byHand.id, ['filed', 'held', 'failed']);
    const b = await settle(viaDoor.itemId!, ['filed', 'held', 'failed']);
    expect([a.state, b.state]).toEqual(['filed', 'filed']);
    const conceptA = await repoFile(a.filedPaths[0]!);
    const conceptB = await repoFile(b.filedPaths[0]!);
    for (const concept of [conceptA, conceptB]) {
      expect(concept).toContain('The renewal is due on 1 December');
      expect(concept).not.toContain('steal()');
    }
    const children = async (id: string): Promise<string[]> =>
      (await world.system((tx) => tx.query<{ name: string }>('SELECT name FROM app.memory_inbox_items WHERE parent_id = $1 ORDER BY name', [id]))).rows.map((r) => r.name);
    await eventually(async () => ((await children(a.id)).length >= 2 ? true : false), 30_000, 'the hand drop’s attachment items');
    // the hand drop made an item of each attachment; the door's copy of the same message has the attachments the team did not already hold (an attachment
    // with the same bytes as a live item is not made twice), so it is a subset of the first, never different
    expect(await children(a.id)).toEqual(['contract.pdf', 'forwarded.eml']);
    for (const name of await children(b.id)) expect(await children(a.id)).toContain(name);
    // same title rule: the door takes it from the subject, the hand drop from the name it was given; both read the same message
    expect(b.name).toBe('Renewal – contract 42');
  });
});

describe('a message nobody could vouch for', () => {
  const held = async (message: string, query: string | undefined, reason: string): Promise<Item> => {
    const { delivery } = await deliverOne(message, query);
    expect(delivery.status).toBe('received');
    const it = await settle(delivery.itemId!, ['held', 'filed', 'failed']);
    expect(it.state, it.name).toBe('held');
    expect(it.holdReason).toBe(reason);
    return it;
  };

  it('is held when the sending domain failed the check, and is credited to nobody', async () => {
    const it = await held(mail({ subject: 'Forged one' }), 'spf=fail&dkim=pass', 'failed_sender_check');
    expect(it).toMatchObject({ origin: 'email', sender: 'nadia@kahf.example', senderCheck: 'fail', droppedBy: null, droppedByName: null });
  });

  it('is held when the transport reported nothing at all', async () => {
    const it = await held(mail({ subject: 'No verdict' }), '', 'failed_sender_check');
    expect(it.senderCheck).toBe('fail');
    expect(it.droppedBy).toBeNull();
  });

  it('is held when only a soft fail came back', async () => {
    await held(mail({ subject: 'Soft fail' }), 'spf=softfail', 'failed_sender_check');
  });

  it('is not saved by an Authentication-Results header written inside the message', async () => {
    const forged = mail({ subject: 'Trust me', extra: ['Authentication-Results: mx.kahf.example; spf=pass; dkim=pass', 'Received-SPF: pass', 'X-Spam-Status: No'] });
    const it = await held(forged, 'spf=fail', 'failed_sender_check');
    expect(it.senderCheck).toBe('fail');
  });

  it('is held, from a stranger who passed the check, until a lead lets it in', async () => {
    const it = await held(mail({ from: 'Vendor <vendor@partner.example>', subject: 'Invoice question' }), undefined, 'unknown_sender');
    expect(it).toMatchObject({ senderCheck: 'none', sender: 'vendor@partner.example', droppedBy: null });
  });

  it('is held for a person who is not on the team (the team’s own people only skip the line)', async () => {
    const it = await held(mail({ from: sameera.email, subject: 'From another team' }), undefined, 'unknown_sender');
    expect(it.senderCheck).toBe('none');
    expect(it.droppedBy).toBeNull();
  });

  it('can be let in by a lead, and is then filed', async () => {
    const it = await held(mail({ from: 'Vendor <vendor@partner.example>', subject: 'Let this one in' }), undefined, 'unknown_sender');
    expect((await world.call(nadia, 'POST', `/api/teams/engineering/inbox/items/${it.id}/release`)).status).toBe(403);
    expect((await world.call(omar, 'POST', `/api/teams/engineering/inbox/items/${it.id}/release`)).status).toBe(200);
    expect((await settle(it.id, ['filed'])).state).toBe('filed');
  });
});

describe('the team names addresses it trusts', () => {
  it('lets mail in from a listed address that passed the check, but not one that failed it', async () => {
    await setTeamMd('memory:\n  inbox:\n    allowEmailFrom:\n      - vendor@partner.example\n');
    expect((await emailInfo(nadia)).body).toMatchObject({ allowedSenders: ['vendor@partner.example'] });
    expect((await emailInfo(nadia)).body.rule).toContain('listed here');
    const ok = await deliverOne(mail({ from: 'vendor@partner.example', subject: 'Listed sender' }));
    const filed = await settle(ok.delivery.itemId!, ['held', 'filed', 'failed']);
    expect(filed.state).toBe('filed');
    expect(filed.senderCheck).toBe('none');
    const bad = await deliverOne(mail({ from: 'vendor@partner.example', subject: 'Listed sender, forged' }), 'spf=fail');
    const held = await settle(bad.delivery.itemId!, ['held', 'filed', 'failed']);
    expect(held).toMatchObject({ state: 'held', holdReason: 'failed_sender_check' });
    // an address that is not listed is still a stranger
    const other = await deliverOne(mail({ from: 'other@partner.example', subject: 'Not listed' }));
    expect(await settle(other.delivery.itemId!, ['held', 'filed', 'failed'])).toMatchObject({ state: 'held', holdReason: 'unknown_sender' });
  });

  it('holds everything when the team asks for every drop to be looked at, whoever sent it', async () => {
    await setTeamMd('memory:\n  inbox:\n    review: all\n');
    const one = await deliverOne(mail({ subject: 'Even from a member' }));
    expect(await settle(one.delivery.itemId!, ['held', 'filed', 'failed'])).toMatchObject({ state: 'held', holdReason: 'review_all', senderCheck: 'pass' });
    await setTeamMd('name: Engineering\n');
  });
});

describe('several teams', () => {
  it('delivers one message to each team named in To and Cc, once each, and says what happened to each', async () => {
    const res = await deliver(omar, mail({ from: tariq.email, to: [ADDRESS('marketing'), ADDRESS('engineering')], cc: [ADDRESS('marketing'), ADDRESS('no-such-team'), 'friend@elsewhere.example'], subject: 'For two teams' }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const bySlug = Object.fromEntries(res.body.deliveries.map((d) => [d.teamSlug, d]));
    expect(Object.keys(bySlug).sort()).toEqual(['engineering', 'marketing', 'no-such-team']);
    expect(bySlug['marketing']).toMatchObject({ status: 'received' });
    expect(bySlug['engineering']).toMatchObject({ status: 'received' });
    expect(bySlug['no-such-team']).toMatchObject({ status: 'ignored', itemId: null });
    expect(bySlug['marketing']!.itemId).not.toBe(bySlug['engineering']!.itemId);
    // Tariq leads Marketing, so there it goes straight in; in Engineering he is a stranger and the mail waits
    const eng = await settle(bySlug['engineering']!.itemId!, ['held', 'filed', 'failed']);
    expect(eng).toMatchObject({ state: 'held', holdReason: 'unknown_sender', senderCheck: 'none' });
    const marketing = (await world.call<{ item: Item }>(tariq, 'GET', `/api/teams/marketing/inbox/items/${bySlug['marketing']!.itemId!}`)).body.item;
    expect(marketing).toMatchObject({ origin: 'email', senderCheck: 'pass', droppedBy: tariq.actorId });
  });

  it('delivers to at most five teams in one message', async () => {
    const slugs = ['engineering', 'marketing', 'customer-support', 'team-4', 'team-5', 'team-6', 'team-7'];
    const res = await deliver(omar, mail({ to: slugs.map(ADDRESS), subject: 'Too many teams' }));
    expect(res.status).toBeLessThan(300);
    expect(res.body.deliveries).toHaveLength(7);
    expect(res.body.deliveries.slice(5).every((d) => d.status === 'ignored' && (d.reason ?? '').includes('at most 5'))).toBe(true);
  });
});
