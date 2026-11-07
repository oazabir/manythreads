import type { PluginContext } from '@manythreads/sdk';
import {
  ListBotConsentsResponse,
  SetBotConsentParams,
  SetBotConsentRequest,
  SetBotConsentResponse,
  listBotConsentsRoute,
  setBotConsentRoute,
  type BotPersonalConsent,
} from '@manythreads/shared';
import { forbidden, json, notFound, route } from './http.ts';

// Which bots may read a person's Personal space (P20-09). The Account page lists every bot the person can see with the answer in force, and sets one answer.
// The answer is the person's own (RLS on `bot_personal_consents`); the gateway reads it through `app.run_space_context()` on every tool call, so a no is
// enforced on the bot's next call. docs/plugins/bots.md.

type ConsentRow = {
  bot_id: string;
  bot_slug: string;
  bot_name: string;
  can_ask: boolean;
  allowed: boolean;
  is_default: boolean;
  changed_at: Date | null;
};

const toConsent = (r: ConsentRow): BotPersonalConsent => ({
  botId: r.bot_id as BotPersonalConsent['botId'],
  botSlug: r.bot_slug as BotPersonalConsent['botSlug'],
  botName: r.bot_name,
  canAsk: r.can_ask,
  allowed: r.allowed,
  isDefault: r.is_default,
  changedAt: r.changed_at === null ? null : r.changed_at.toISOString(),
});

export function registerConsentRoutes(ctx: PluginContext): void {
  ctx.http.route({
    ...listBotConsentsRoute,
    schema: { response: ListBotConsentsResponse },
    handler: route(async (_req, tx) => {
      const rows = await tx.query<ConsentRow>('SELECT bot_id, bot_slug, bot_name, can_ask, allowed, is_default, changed_at FROM app.bot_consent_rows()');
      return json(ListBotConsentsResponse.parse({ items: rows.rows.map(toConsent) }));
    }),
  });

  ctx.http.route({
    ...setBotConsentRoute,
    schema: { body: SetBotConsentRequest, response: SetBotConsentResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { botId } = SetBotConsentParams.parse(req.params);
      const { allowed } = SetBotConsentRequest.parse(req.body);
      const personId = (await tx.query<{ id: string | null }>('SELECT app.person_id() AS id')).rows[0]?.id ?? null;
      if (personId === null) throw forbidden('Only a person answers for their own space');
      // the person must be able to see the bot (and not be a guest: the list is empty for them)
      const listed = await tx.query<ConsentRow>('SELECT bot_id, bot_slug, bot_name, can_ask, allowed, is_default, changed_at FROM app.bot_consent_rows() WHERE bot_id = $1', [botId]);
      if (listed.rows.length === 0) throw notFound('No such bot');
      await tx.query(
        `INSERT INTO app.bot_personal_consents (person_id, bot_id, workspace_id, allowed) VALUES ($1, $2, app.workspace_id(), $3)
         ON CONFLICT (person_id, bot_id) DO UPDATE SET allowed = EXCLUDED.allowed, changed_at = now()`,
        [personId, botId, allowed],
      );
      await ctx.audit.emit(tx, { type: 'bots.personal_consent.changed', personId, botId, allowed, at: new Date().toISOString() });
      const after = await tx.query<ConsentRow>('SELECT bot_id, bot_slug, bot_name, can_ask, allowed, is_default, changed_at FROM app.bot_consent_rows() WHERE bot_id = $1', [botId]);
      return json(SetBotConsentResponse.parse({ item: toConsent(after.rows[0]!) }));
    }),
  });
}
