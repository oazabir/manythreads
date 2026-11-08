import { createHmac, timingSafeEqual } from 'node:crypto';
import type { BridgeAdapter, BridgeRequest, InboundMessage } from '../adapter.ts';
import { BridgeSendError, bridgeCall, failureOf, readJson } from '../door.ts';
import { cleanLabel } from '../text.ts';

// The WhatsApp Business (Cloud API) adapter (PLAN Bundle D, P16-09, decision D29): direct chats with the number only. Meta signs every call with the app secret
// (`X-Hub-Signature-256: sha256=<hmac of the raw body>`), and checks the callback address once with a GET that carries our verify word (`hub.verify_token`).
// The access token sends; the phone number id (the account's `externalAppId`) says which number a call is about, and a call about another number is not read.

const GRAPH_VERSION = 'v21.0';

const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const rec = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** `/<command> <argument>` as people type it to a bot. */
const COMMAND = /^\/(start|connect|unlink|bot)(?:[ \t]+([\s\S]*))?$/i;

export const whatsappAdapter: BridgeAdapter = {
  provider: 'whatsapp',

  verify(account, req: BridgeRequest) {
    const secret = account.secrets.app_secret;
    const header = req.headers['x-hub-signature-256'] ?? '';
    const expected = secret ? `sha256=${createHmac('sha256', secret).update(req.rawBody).digest('hex')}` : '';
    // computed and compared even when something is missing, so the time says nothing
    const ok = secret !== undefined && secret.length > 0 && header.length > 0 && same(header, expected);
    return ok ? { ok: true } : { ok: false, reason: 'bad_signature' };
  },

  challenge(account, req) {
    const q = req.query;
    const word = account.secrets.inbound_secret;
    if (q['hub.mode'] !== 'subscribe' || !word || !same(q['hub.verify_token'] ?? '', word)) return null;
    const challenge = q['hub.challenge'] ?? '';
    // Meta sends a number; only that is echoed (never markup)
    return /^[0-9A-Za-z_-]{1,64}$/.test(challenge) ? challenge : null;
  },

  parse(account, body): InboundMessage[] {
    const out: InboundMessage[] = [];
    for (const entry of arr(rec(body)['entry'])) {
      for (const change of arr(rec(entry)['changes'])) {
        const value = rec(rec(change)['value']);
        const numberId = str(rec(value['metadata'])['phone_number_id']);
        // a call about another number is not ours
        if (account.externalAppId !== null && numberId !== account.externalAppId) continue;
        const names = new Map<string, string>();
        for (const c of arr(value['contacts'])) {
          const wa = str(rec(c)['wa_id']);
          const name = str(rec(rec(c)['profile'])['name']);
          if (wa !== null && name !== null) names.set(wa, name);
        }
        for (const m of arr(value['messages'])) {
          const msg = rec(m);
          const id = str(msg['id']);
          const from = str(msg['from']);
          if (id === null || from === null || !/^[0-9]{5,20}$/.test(from) || msg['type'] !== 'text') continue;
          const text = str(rec(msg['text'])['body']);
          if (text === null) continue;
          const c = COMMAND.exec(text.trim());
          const seconds = Number(msg['timestamp']);
          out.push({
            updateId: id,
            externalId: id,
            // WhatsApp has only direct chats here: the chat is the person's number
            chat: { id: from, kind: 'private', title: null },
            sender: { id: from, label: cleanLabel(names.get(from) ?? `+${from}`) },
            text,
            command: c ? { name: c[1]!.toLowerCase() as 'start' | 'connect' | 'unlink' | 'bot', argument: (c[2] ?? '').trim() } : null,
            at: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null,
          });
        }
      }
    }
    return out;
  },

  async send(account, chat, text) {
    const token = account.secrets.bot_token;
    if (!token) throw new BridgeSendError('This chat app has no access token', { retry: false, attention: true });
    if (account.externalAppId === null || !/^[0-9]{5,30}$/.test(account.externalAppId)) throw new BridgeSendError('This chat app has no phone number id', { retry: false, attention: true });
    const res = await bridgeCall({
      provider: 'whatsapp',
      path: `/${GRAPH_VERSION}/${account.externalAppId}/messages`,
      headers: { authorization: `Bearer ${token}` },
      json: { messaging_product: 'whatsapp', recipient_type: 'individual', to: chat, type: 'text', text: { preview_url: false, body: text } },
    });
    const doc = readJson(res.text);
    if (res.status >= 200 && res.status < 300) {
      const id = str(rec(arr(doc?.['messages'])[0])['id']);
      if (id !== null) return id;
      throw new BridgeSendError('WhatsApp did not say which message it sent', { retry: false });
    }
    throw failureOf(res.status, null, 'WhatsApp refused the message');
  },

  async connect(account) {
    const token = account.secrets.bot_token;
    if (!token || account.externalAppId === null || !/^[0-9]{5,30}$/.test(account.externalAppId)) throw new BridgeSendError('Add the phone number id and the access token first', { retry: false });
    const res = await bridgeCall({
      provider: 'whatsapp',
      method: 'GET',
      path: `/${GRAPH_VERSION}/${account.externalAppId}?fields=display_phone_number`,
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.status !== 200) throw failureOf(res.status, null, 'WhatsApp did not accept the access token');
    const phone = str(readJson(res.text)?.['display_phone_number']);
    // Meta is told the callback address by hand in its console: nothing is registered from here
    return { handle: phone === null ? null : cleanLabel(phone, 40), externalAppId: account.externalAppId };
  },
};
