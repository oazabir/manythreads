import { definePlugin } from '@manythreads/sdk';
import { ListLinksRequest, ListLinksResponse, listLinksRoute, type ListedLink } from '@manythreads/shared';

/**
 * HTTP face of the kernel entity-link service (`ctx.links`, P3-04): `GET /api/links?type=&id=` lists the links of one entity with the
 * entity at the other end resolved to a summary. Resolvers run in the caller's transaction, so RLS applies to every lookup: a link whose
 * other end the caller cannot see is left out, and so are all links of an entity the caller cannot see.
 */
export default definePlugin({
  manifest: { name: 'entity-links', version: '0.1.0', kind: 'server' },
  register(ctx) {
    ctx.http.route({
      method: listLinksRoute.method,
      path: listLinksRoute.path,
      schema: { query: ListLinksRequest, response: ListLinksResponse },
      handler: async (req, tx) => {
        const q = ListLinksRequest.parse(req.query);
        const subject = { type: q.type, id: q.id };
        // Links are visible to the team, but the entity itself may be private (a message in a private channel): when its
        // type has a resolver, the caller must be able to see it too. Without a resolver nothing can be shown, so nothing is.
        if (await ctx.links.resolve(tx, subject).then((s) => s === null)) return { body: { links: [] } };
        const links = await ctx.links.list(tx, subject, q.direction, { limit: q.limit, ...(q.kind ? { kind: q.kind } : {}) });
        const out: ListedLink[] = [];
        for (const link of links) {
          const isOut = link.src.type === subject.type && link.src.id === subject.id;
          const other = await ctx.links.resolve(tx, isOut ? link.dst : link.src);
          if (other) out.push({ link, direction: isOut ? 'out' : 'in', other });
        }
        return { body: { links: out } };
      },
    });
  },
});
