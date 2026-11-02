import type { PluginTx } from '@manythreads/sdk';
import type { EmailTransport, ListMailQuery, MailDirection, MailMessage, MailSummary, OutgoingMail } from './transport.ts';

// The dummy mail transport (PLAN P8-29): a mailbox that is a table, `app.connection_messages`, with mail in (`in`) and mail out (`out`, `draft`). It is what the tests and the
// support journey use in place of a real provider: mail is put in through the admin-only delivery door (`POST /api/teams/:slug/connections/:connection/mail`), and what a bot
// sends lands in the same table as an `out` row that a test can read back. It implements exactly the interface a real transport will, and nothing else.
//
// It runs in the caller's transaction, so the caller's row-level security decides what it can see; sending and saving go through the one definer function
// `app.connection_mail_put_outbound`, which checks the caller's grant and takes the recipient of a reply from the stored inbound mail (the migration says why).

type MailRow = {
  id: string;
  seq: string;
  direction: MailDirection;
  folder: string;
  thread_key: string;
  message_id: string;
  in_reply_to: string | null;
  from_address: string;
  to_address: string;
  subject: string;
  body: string;
  created_at: Date;
  [key: string]: unknown;
};

const COLUMNS = 'm.id, m.seq, m.direction, m.folder, m.thread_key, m.message_id, m.in_reply_to, m.from_address, m.to_address, m.subject, m.body, m.created_at';

const summaryOf = (row: MailRow): MailSummary => ({
  id: row.id,
  seq: Number(row.seq),
  direction: row.direction,
  folder: row.folder,
  threadKey: row.thread_key,
  messageRef: row.message_id,
  from: row.from_address,
  to: row.to_address,
  subject: row.subject,
  at: row.created_at.toISOString(),
});

/** The search words of a query: whitespace-separated, at most `MAX_WORDS`, each cut to `MAX_WORD` characters, lower case. Linear in the input. */
const MAX_WORDS = 8;
const MAX_WORD = 60;
export const wordsOf = (words: string | undefined): string[] =>
  (words ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== '')
    .slice(0, MAX_WORDS)
    .map((w) => w.slice(0, MAX_WORD));

export function createDummyTransport(tx: PluginTx, connection: { id: string }): EmailTransport {
  const outbound = async (tool: 'email.send' | 'email.draft', mail: OutgoingMail): Promise<{ id: string }> => {
    const res = await tx.query<{ id: string }>('SELECT app.connection_mail_put_outbound($1::uuid, $2, $3::uuid, $4, $5, $6) AS id', [
      connection.id,
      tool,
      mail.inReplyTo,
      mail.to,
      mail.subject,
      mail.body,
    ]);
    return { id: res.rows[0]!.id };
  };

  return {
    id: 'dummy',

    async list(query: ListMailQuery): Promise<MailSummary[]> {
      const params: unknown[] = [connection.id, query.limit];
      const where: string[] = ['m.connection_id = $1'];
      if (query.direction) where.push(`m.direction = $${params.push(query.direction)}`);
      if (query.folder) where.push(`lower(m.folder) = lower($${params.push(query.folder)})`);
      if (query.threadKey !== undefined) where.push(`m.thread_key = $${params.push(query.threadKey)}`);
      if (query.since) where.push(`m.created_at >= $${params.push(query.since)}`);
      for (const word of wordsOf(query.words)) {
        where.push(`strpos(lower(m.subject || ' ' || m.from_address || ' ' || m.body), $${params.push(word)}) > 0`);
      }
      const rows = await tx.query<MailRow>(`SELECT ${COLUMNS} FROM app.connection_messages m WHERE ${where.join(' AND ')} ORDER BY m.seq DESC LIMIT $2`, params);
      return rows.rows.map(summaryOf);
    },

    async fetch(id: string): Promise<MailMessage | null> {
      const row = (await tx.query<MailRow>(`SELECT ${COLUMNS} FROM app.connection_messages m WHERE m.connection_id = $1 AND m.id = $2::uuid`, [connection.id, id])).rows[0];
      return row ? { ...summaryOf(row), body: row.body, inReplyTo: row.in_reply_to } : null;
    },

    send: (mail) => outbound('email.send', mail),
    draft: (mail) => outbound('email.draft', mail),
  };
}
