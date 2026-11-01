import {
  ChannelPollCreatedEvent,
  ChannelPollVotedEvent,
  ClosePollResponse,
  CreatePollRequest,
  CreatePollResponse,
  PollChannelPathParams,
  PollPathParams,
  POLL_ANONYMOUS_MIN_READERS,
  POLL_ANONYMOUS_TOO_SMALL,
  PollResultsResponse,
  VotePollRequest,
  VotePollResponse,
  checkClosesAt,
  closePollRoute,
  createPollRoute,
  pollBodyText,
  pollResultsRoute,
  votePollRoute,
  withdrawVoteRoute,
} from '@manythreads/shared';
import { conflict, forbidden, invalid, json, notFound, route } from './http.ts';
import { findPoll } from './poll-views.ts';
import { POLL_CLOSED, closePoll, pushPollChanged, reloadPoll } from './polls.ts';
import { audience, myPersonId, postChannelMessage, requireChannel, findChannelMessage, type Deps } from './service.ts';

const POLL_DELETED = 'That poll was deleted';

/** Polls are for people: a bot reads a poll and its result like any message but neither asks nor votes. */
async function requirePerson(tx: Parameters<typeof myPersonId>[0]): Promise<string> {
  const id = await myPersonId(tx);
  if (!id) throw forbidden('Polls are for people');
  return id;
}

/**
 * Polls (PLAN P14-07): create one as a message, vote, change or withdraw a vote, close it, read its results. The votes live in `poll_votes`, whose
 * row-level security lets a ballot of an anonymous poll be read by its voter only (migration 0014); these routes never ask for more than that.
 */
export function registerPollRoutes(deps: Deps): void {
  const { ctx } = deps;

  ctx.http.route({
    ...createPollRoute,
    schema: { body: CreatePollRequest, response: CreatePollResponse },
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { channelId } = PollChannelPathParams.parse(req.params);
      const body = CreatePollRequest.parse(req.body);
      await requirePerson(tx);
      const channel = await requireChannel(tx, channelId);
      if (channel.kind === 'bot_conversation') throw invalid('A conversation with a bot cannot hold a poll');
      // The ballots of an anonymous poll are unreadable to everyone, but the totals move live: in a small group that alone shows who voted.
      if (body.anonymous && (channel.kind === 'dm' || (await audience(tx, channelId)).length < POLL_ANONYMOUS_MIN_READERS)) throw invalid(POLL_ANONYMOUS_TOO_SMALL);
      let closesAt: string | null = null;
      if (body.closesAt) {
        const when = checkClosesAt(body.closesAt, ctx.runtime.now());
        if (!when.ok) throw invalid(`closesAt: ${when.reason}`);
        closesAt = when.at.toISOString();
      }
      const poll = (await tx.query<{ id: string }>('SELECT uuidv7() AS id')).rows[0]!;
      // The message first (the one door every message is written through: permission, archive, thread rules, event, unread), then the poll row that
      // points at it; both commit together, and the push the post makes carries no message, so each reader fetches the card with their own ballot.
      const posted = await postChannelMessage(deps, tx, {
        channelId,
        body: pollBodyText({ question: body.question, options: body.options, multiple: body.multiple, anonymous: body.anonymous, closesAt }),
        threadRootId: body.threadRootId ?? null,
        meta: { poll: { id: poll.id } },
        skipRefs: true,
      });
      try {
        await tx.query(
          `INSERT INTO app.polls (id, workspace_id, channel_id, message_id, author_id, question, options, multiple, anonymous, closes_at)
           VALUES ($1, app.workspace_id(), $2, $3, app.actor(), $4, $5::text[], $6, $7, $8::timestamptz)`,
          [poll.id, channelId, posted.id, body.question, body.options, body.multiple, body.anonymous, closesAt],
        );
      } catch (err) {
        // the database applies the same rules as the schema (one line each, no two options alike); if it still says no, it is the sender's mistake, not a failure
        if ((err as { code?: string } | null)?.code === '23514') throw invalid((err as { message?: string }).message ?? 'That poll is not allowed');
        throw err;
      }
      await ctx.audit.emit(
        tx,
        ChannelPollCreatedEvent.parse({
          type: 'channel.poll.created',
          schemaVersion: 1,
          workspaceId: tx.actor.workspaceId,
          channelId,
          teamId: channel.team_id,
          pollId: poll.id,
          messageId: posted.id,
          authorId: tx.actor.id,
          optionCount: body.options.length,
          multiple: body.multiple,
          anonymous: body.anonymous,
          closesAt,
        }),
      );
      const message = await findChannelMessage(tx, channelId, posted.id);
      return json(CreatePollResponse.parse(message), 201);
    }),
  });

  ctx.http.route({
    ...votePollRoute,
    schema: { body: VotePollRequest, response: VotePollResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { channelId, pollId } = PollPathParams.parse(req.params);
      const { options } = VotePollRequest.parse(req.body);
      await requirePerson(tx);
      const channel = await requireChannel(tx, channelId);
      const poll = await findPoll(tx, channelId, pollId);
      if (!poll) throw notFound('No such poll');
      if (poll.message_deleted) throw conflict(POLL_DELETED);
      if (channel.archived_at) throw conflict('This channel is archived');
      if (poll.closed) throw conflict(POLL_CLOSED);
      if (options.some((o) => o >= poll.options.length)) throw invalid('options: that option does not exist');
      if (!poll.multiple && options.length !== 1) throw invalid('options: this poll takes one choice');
      // the ballot is one row: a new vote inserts it, a changed vote replaces its choices; the triggers check the poll again under its lock and move the totals
      await tx.query(
        `INSERT INTO app.poll_votes (poll_id, voter_id, choices) VALUES ($1, app.actor(), $2::smallint[])
         ON CONFLICT (poll_id, voter_id) DO UPDATE SET choices = EXCLUDED.choices`,
        [pollId, options],
      );
      const { row, view } = await reloadPoll(tx, channelId, pollId);
      // A named poll's vote is an event (who chose what is public in it anyway). An anonymous poll's is not: the log would name the voter and the time.
      if (!poll.anonymous) {
        await ctx.audit.emit(
          tx,
          ChannelPollVotedEvent.parse({
            type: 'channel.poll.voted',
            schemaVersion: 1,
            workspaceId: tx.actor.workspaceId,
            channelId,
            teamId: channel.team_id,
            pollId,
            messageId: poll.message_id,
            voterId: tx.actor.id,
            anonymous: false,
            options: [...options].sort((a, b) => a - b),
          }),
        );
      }
      await pushPollChanged(deps, tx, row);
      return json(VotePollResponse.parse({ poll: view }));
    }),
  });

  ctx.http.route({
    ...withdrawVoteRoute,
    schema: { response: VotePollResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { channelId, pollId } = PollPathParams.parse(req.params);
      await requirePerson(tx);
      const channel = await requireChannel(tx, channelId);
      const poll = await findPoll(tx, channelId, pollId);
      if (!poll) throw notFound('No such poll');
      if (poll.message_deleted) throw conflict(POLL_DELETED);
      if (channel.archived_at) throw conflict('This channel is archived');
      if (poll.closed) throw conflict(POLL_CLOSED);
      const res = await tx.query('DELETE FROM app.poll_votes WHERE poll_id = $1 AND voter_id = app.actor() RETURNING poll_id', [pollId]);
      const { row, view } = await reloadPoll(tx, channelId, pollId);
      if (res.rows.length > 0) {
        if (!poll.anonymous) {
          await ctx.audit.emit(
            tx,
            ChannelPollVotedEvent.parse({
              type: 'channel.poll.voted',
              schemaVersion: 1,
              workspaceId: tx.actor.workspaceId,
              channelId,
              teamId: channel.team_id,
              pollId,
              messageId: poll.message_id,
              voterId: tx.actor.id,
              anonymous: false,
              options: [],
            }),
          );
        }
        await pushPollChanged(deps, tx, row);
      }
      return json(VotePollResponse.parse({ poll: view }));
    }),
  });

  ctx.http.route({
    ...closePollRoute,
    schema: { response: ClosePollResponse },
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { channelId, pollId } = PollPathParams.parse(req.params);
      await requirePerson(tx);
      await requireChannel(tx, channelId);
      const poll = await findPoll(tx, channelId, pollId);
      if (!poll) throw notFound('No such poll');
      // The author, a team lead of the channel's team or a workspace admin may close it; an archived channel or a deleted message does not stop that
      // (the poll then closes without a result message: nobody may post one there). Whoever lost the right to post closes it without one too.
      const { view } = await closePoll(deps, tx, channelId, pollId, 'author');
      return json(ClosePollResponse.parse({ poll: view }));
    }),
  });

  ctx.http.route({
    ...pollResultsRoute,
    schema: { response: PollResultsResponse },
    rateLimit: { limit: 300, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { channelId, pollId } = PollPathParams.parse(req.params);
      await requireChannel(tx, channelId);
      const poll = await findPoll(tx, channelId, pollId);
      // a deleted message takes its poll with it: the results are not served any more
      if (!poll || poll.message_deleted) throw notFound('No such poll');
      const view = (await reloadPoll(tx, channelId, pollId)).view;
      if (poll.anonymous) return json(PollResultsResponse.parse({ poll: view, voters: null }));
      const res = await tx.query<{ actor_id: string; display_name: string; choices: number[] }>('SELECT actor_id, display_name, choices FROM app.poll_voters($1)', [pollId]);
      return json(PollResultsResponse.parse({ poll: view, voters: res.rows.map((r) => ({ actorId: r.actor_id, displayName: r.display_name, options: r.choices })) }));
    }),
  });
}
