# surfaces

Surfaces are screens a bot draws instead of plain text: a heading, a table, a form. The bot writes the screen as text in OpenUI Lang (an MIT-licensed way of describing a screen), and the web app draws it, one part at a time, after checking each part. This page covers what exists so far (PLAN P9-01 to P9-03): the tables, the list of parts a bot may use, and the web renderer. The tools a bot calls to draw (`surface.render`, `surface.update`, `surface.event`, P9-04), data binding (P9-06), the richer parts (P9-05, P9-08) and export to pages (P9-09) are not built. Code: `packages/plugins/surfaces` (tables only), `packages/shared/src/surfaces` (registry and checker), `clients/web/src/surfaces` (renderer). `dependsOn` channels and bots.

## Tables (migration `0001_surfaces.sql`, namespace `surfaces`)

- `surfaces`: one row per screen: its channel (a bot conversation is a channel too), the bot, the run that drew it, the thread it was drawn in, the text, a version that goes up by one whenever the text changes, and the pin. Whoever can read the channel reads the surface. Only the bot that owns it draws or changes it, as itself and inside one of its own runs; the database fills the author, run, version and team and ignores what the caller sends for them. A person who can post in the channel may pin or unpin it. A surface can be pinned only to its own channel for now, because pinning to another channel would let that channel's readers see it.
- `surface_events`: the history, written once and never changed: `render`, `update`, `rejected` (bot lines), `event` (a click or form sent back), `pinned`, `unpinned`, `exported` (person lines). A line carries the version it was about, the part it was about (`node_id`) and a JSON object payload of at most 64 KB.

## The list of parts and the checker

`SURFACE_REGISTRY` (`packages/shared/src/surfaces/components.ts`) lists the parts: a name, the order of its values, which value holds child parts, and a Zod schema for the rest. Today: `Stack`, `Heading`, `Text`. The checker (`openui.ts`) reads text in any chunking and answers with a tree where every part is a registered name with props that passed its schema, or a rejection (`syntax`, `unknown_component`, `invalid_props`, `unresolved_ref`, `cycle`, `too_deep`, `too_large`, `duplicate`). A rejected part is replaced by a card and its neighbours stay. Limits: 200,000 characters, 500 statements, 60,000 characters per statement, 16 levels deep, 2,000 parts drawn, 200 children per part, 20,000 characters of values per part. The server will run the same code for `surface.render` (P9-04).

## The web renderer

`<Surface source ended />` draws the text so far; while `ended` is false each part still to come is a grey placeholder. Text is always drawn as text, never as markup; there are no links, images or scripts in the parts that exist.
