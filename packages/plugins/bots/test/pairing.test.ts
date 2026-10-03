import { randomUUID } from 'node:crypto';
import { MintPairingTokenResponse, RevokePairingTokensResponse } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRepoWorld, personas, TEAM_IDS, type RepoWorld } from '../../repo-git/test/world.ts';
import { hashPairingToken, newPairingToken, resolvePairingToken } from '../src/pairing.ts';

// Pairing tokens (PLAN P5-04): a lead of the team mints the credential a bot's runtime presents, the database keeps only its sha256,
// resolving it answers the bot's ids and actor row, and revoking turns every live token off. The definer functions re-check `manage`
// for themselves (a route check is a courtesy, not the security).

const { omar, priya, sameera, lena } = personas;
vi.setConfig({ testTimeout: 60_000 });

let w: RepoWorld;
let bot: { botId: string; actorId: string };
beforeAll(async () => {
  w = await createRepoWorld();
  // A loaded bot, made directly rather than through a commit: this file is about the token, not the loader.
  bot = await w.system(async (tx) => {
    const row = await tx.query<{ id: string }>(
      `INSERT INTO app.bots (workspace_id, team_id, slug, kind, runtime, visibility, definition_sha, status)
       VALUES ($1, $2, 'pairbot', 'agent', 'rules', 'team', repeat('a', 64), 'active') RETURNING id`,
      [personas.omar.workspaceId, TEAM_IDS.Engineering],
    );
    const botId = row.rows[0]!.id;
    const actor = await tx.query<{ id: string }>(
      `INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id`,
      [personas.omar.workspaceId, botId],
    );
    return { botId, actorId: actor.rows[0]!.id };
  });
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const MINT = (slug = 'pairbot') => `/api/teams/engineering/bots/${slug}/pairing-tokens`;
const liveTokens = () =>
  w.system(async (tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.bot_pairing_tokens WHERE bot_id = $1 AND revoked_at IS NULL', [bot.botId])).rows[0]!.n);
const mintHash = (token: string) => w.system((tx) => tx.query('SELECT * FROM app.bots_pairing_mint($1, $2)', [bot.botId, hashPairingToken(token)]));

describe('pairing tokens', () => {
  it('a lead mints one: shown once, stored as sha256 only, and it resolves to the bot actor', async () => {
    const res = await w.call(omar, 'POST', MINT(), {});
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const minted = MintPairingTokenResponse.parse(res.body);
    expect(minted.token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes, base64url

    const stored = await w.system(async (tx) =>
      (await tx.query<{ token_hash: Buffer }>('SELECT token_hash FROM app.bot_pairing_tokens WHERE bot_id = $1', [bot.botId])).rows,
    );
    expect(stored).toHaveLength(1);
    expect(Buffer.compare(stored[0]!.token_hash, hashPairingToken(minted.token))).toBe(0); // the raw token is nowhere in the table

    const paired = await w.as(omar, (tx) => resolvePairingToken(tx, minted.token));
    expect(paired).toEqual({
      botId: bot.botId,
      teamId: TEAM_IDS.Engineering,
      workspaceId: personas.omar.workspaceId,
      actorId: bot.actorId,
      slug: 'pairbot',
    });
  });

  it('an unknown or forged token resolves to nothing — one answer for both', async () => {
    expect(await w.as(omar, (tx) => resolvePairingToken(tx, newPairingToken()))).toBeNull();
    expect(await w.system((tx) => resolvePairingToken(tx, 'not-a-token'))).toBeNull();
  });

  it('only a lead of the team mints: a member, another team\'s member, a guest are 403, nobody is 401, unknown slugs are 404', async () => {
    for (const who of [priya, sameera, lena]) {
      const res = await w.call(who, 'POST', MINT(), {});
      expect(res.status, who.name).toBe(403);
    }
    expect((await w.call(null, 'POST', MINT(), {})).status).toBe(401);
    expect((await w.call(omar, 'POST', MINT('no-such-bot'), {})).status).toBe(404);
    expect((await w.call(omar, 'POST', '/api/teams/no-such-team/bots/pairbot/pairing-tokens', {})).status).toBe(404);
    expect(await liveTokens()).toBe(1); // none of the refusals wrote anything
  });

  it('the definer functions re-check manage: a member and an outsider get 42501, the system role passes, junk hashes are refused', async () => {
    const token = newPairingToken();
    const hash = hashPairingToken(token);
    await expect(w.as(priya, (tx) => tx.query('SELECT * FROM app.bots_pairing_mint($1, $2)', [bot.botId, hash]))).rejects.toMatchObject({ code: '42501' });
    await expect(w.as(sameera, (tx) => tx.query('SELECT * FROM app.bots_pairing_mint($1, $2)', [bot.botId, hash]))).rejects.toMatchObject({ code: '42501' });
    await expect(w.as(omar, (tx) => tx.query('SELECT * FROM app.bots_pairing_mint($1, $2)', [bot.botId, Buffer.alloc(8)]))).rejects.toMatchObject({ code: '22000' });
    await expect(w.system((tx) => tx.query('SELECT * FROM app.bots_pairing_mint($1, $2)', [randomUUID(), hash]))).rejects.toMatchObject({ code: 'P0002' });

    // the system role (jobs, event handlers) mints and revokes past the caller check — and this cleans up for the next test
    await expect(mintHash(token)).resolves.toBeTruthy();
    const revoked = await w.system((tx) => tx.query<{ revoked: number }>('SELECT app.bots_pairing_revoke($1) AS revoked', [bot.botId]));
    expect(revoked.rows[0]!.revoked).toBe(2); // the route's token from test 1 plus this one
    expect(await liveTokens()).toBe(0);
  });

  it('revoke turns every live token off; a new mint works again', async () => {
    const first = MintPairingTokenResponse.parse((await w.call(omar, 'POST', MINT(), {})).body);
    const second = MintPairingTokenResponse.parse((await w.call(omar, 'POST', MINT(), {})).body);
    expect(await liveTokens()).toBe(2);

    const revoked = RevokePairingTokensResponse.parse((await w.call(omar, 'DELETE', MINT())).body);
    expect(revoked).toEqual({ revoked: 2 });
    expect(await liveTokens()).toBe(0);
    expect(await w.as(omar, (tx) => resolvePairingToken(tx, first.token))).toBeNull();
    expect(await w.as(omar, (tx) => resolvePairingToken(tx, second.token))).toBeNull();

    const again = RevokePairingTokensResponse.parse((await w.call(omar, 'DELETE', MINT())).body);
    expect(again).toEqual({ revoked: 0 });

    const fresh = MintPairingTokenResponse.parse((await w.call(omar, 'POST', MINT(), {})).body);
    const paired = await w.as(omar, (tx) => resolvePairingToken(tx, fresh.token));
    expect(paired).toMatchObject({ botId: bot.botId, actorId: bot.actorId, slug: 'pairbot' });
  });
});
