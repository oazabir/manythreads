# Entity links (kernel service, P3-04)

A typed edge between two entities of one team, so that a message can point at a task, a task at the message it came from, a page at a file.
Plugins use it through `ctx.links` (SDK); the browser through `GET /api/links` (plugin `entity-links`).

## Table `app.entity_links` (kernel 0001, policy 0011, types 0013)

`team_id`, `src_type`, `src_id`, `dst_type`, `dst_id`, `kind`; unique on all five of `(src_type, src_id, dst_type, dst_id, kind)`, plus `(dst_type, dst_id)` for incoming links.
Types are the `EntityType` enum, enforced by CHECK: `message`, `thread`, `task`, `page`, `bot`, `file` (adding one is a forward-only migration). `kind` is lowercase
snake_case up to 40 characters (`mentions`, `attached`, `related`, `created_from`, ...): open, plugins add their own.

RLS is policy **T**, members only: read and write need membership of `team_id`, with no workspace-admin override and nothing for guests (policy
`entity_links_team`, hoisted with `app.member_team_ids('read')`). Verified in `test/rls/entity-links.test.ts`: Nadia (Engineering) and Priya see an
Engineering link; Sameera, Tariq, Lena do not; Omar, an admin who is not on Marketing, does not see a Marketing link; Sameera cannot create or remove one.

## `ctx.links`

```ts
create(tx, { teamId, src: {type,id}, dst: {type,id}, kind }): Promise<{ link: EntityLinkView, created: boolean }>   // idempotent, one INSERT .. ON CONFLICT .. DO SELECT
remove(tx, { src, dst, kind }): Promise<boolean>
list(tx, ref, direction = 'both' | 'out' | 'in', { kind?, limit? }): Promise<EntityLinkView[]>                   // newest first, default 100, max 500
resolve(tx, ref): Promise<EntitySummary | null>
registerResolver(type, (tx, id) => Promise<{ title, subtitle?, href? } | null>): void                               // one per type; a second throws
```

`create` returns the existing link (`created: false`) for the same `(src, dst, kind)`; concurrent callers converge on one row and a hit writes nothing. A link to itself is refused.
A resolver is how the plugin that owns an entity type tells the kernel how to summarise one (`message` and `thread` by channels and threads, `task` by tasks, `page` by
the repo plugin, `bot` by bots, `file` by storage). It runs **in the caller's transaction**, so its own RLS-filtered query answers for the caller: return
`null` for an entity that does not exist or that the caller may not see, never the difference. `resolve` returns `null` when no resolver is registered.

## HTTP

`GET /api/links?type=<EntityType>&id=<uuid>[&direction=out|in|both][&kind=][&limit=1..200]` answers
`{ links: [{ link, direction: 'out' | 'in', other: { type, id, title, subtitle, href } }] }`, newest first. A link whose other end the caller cannot see is left out. When
the asked-about entity itself does not resolve for the caller (private message, type with no resolver), the answer is empty: links are visible to the team, the entity may not be.

## Tests

`packages/kernel/test/rls/entity-links.test.ts`, `packages/plugins/entity-links/test/api.test.ts`, `e2e/api/links/`, and the enum/CHECK comparison in `test/schema-enums.test.ts`.
