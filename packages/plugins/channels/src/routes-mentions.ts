import { ListMentionGroupsResponse, MentionGroupsPathParams, listMentionGroupsRoute } from '@manythreads/shared';
import { json, route } from './http.ts';
import { resolveRoleGroups } from './mentions.ts';
import { requireChannel, type Deps } from './service.ts';

/**
 * `GET /api/channels/:channelId/mention-groups` (P14-03): the role groups the `@` picker offers here, each with how many people a mention reaches in this
 * conversation. It is built from the same two steps a post uses (`resolveRoleGroups`: the teams plugin's list of groups, narrowed to the people who can read
 * this channel), so the number in the picker is the number a mention reaches. It answers only about people the caller could already see in the channel's
 * audience, and a guest, a conversation without a team and a team without groups all get an empty list.
 */
export function registerMentionRoutes(deps: Deps): void {
  deps.ctx.http.route({
    ...listMentionGroupsRoute,
    schema: { response: ListMentionGroupsResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { channelId } = MentionGroupsPathParams.parse(req.params);
      const channel = await requireChannel(tx, channelId);
      const reached = await resolveRoleGroups(deps, tx, channel, 'all');
      return json(
        ListMentionGroupsResponse.parse({
          groups: reached.map(({ group, people }) => ({ handle: group.handle, tag: group.tag, memberCount: people.length })),
        }),
      );
    }),
  });
}
