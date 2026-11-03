# surfaces

Surfaces are screens a bot draws instead of plain text: a heading, a table, a form. The bot writes the screen as text in OpenUI Lang (an MIT-licensed way of describing a screen), and the web app draws it, one part at a time, after checking each part. This page covers what exists so far (PLAN P9-01 to P9-05): the tables, the list of parts a bot may use, the web renderer, the three tools a bot draws with and the routes the web app uses. Data binding (P9-06), the app parts (P9-08) and export to pages (P9-09) are not built. Code: `packages/plugins/surfaces` (tables, tools and routes), `packages/shared/src/surfaces` (registry and checker), `clients/web/src/surfaces` (renderer). `dependsOn` channels and bots.

## Tables (migration `0001_surfaces.sql`, namespace `surfaces`)

- `surfaces`: one row per screen: its channel (a bot conversation is a channel too), the bot, the run that drew it, the thread it was drawn in, the text, a version that goes up by one whenever the text changes, and the pin. Whoever can read the channel reads the surface. Only the bot that owns it draws or changes it, as itself and inside one of its own runs; the database fills the author, run, version and team and ignores what the caller sends for them. A person who can post in the channel may pin or unpin it. A surface can be pinned only to its own channel for now, because pinning to another channel would let that channel's readers see it.
- `surface_events`: the history, written once and never changed: `render`, `update`, `rejected` (bot lines), `event` (a click or form sent back), `pinned`, `unpinned`, `exported` (person lines). A line carries the version it was about, the part it was about (`node_id`) and a JSON object payload of at most 64 KB.

## The list of parts and the checker

`SURFACE_REGISTRY` (`packages/shared/src/surfaces/components.ts`) lists the parts: a name, the order of its values, which value holds child parts, and a Zod schema for the rest. Today (P9-05): the primitives `Stack`, `Row`, `Grid`, `Heading`, `Text`, `Stat`, `Table`, `Chart`, `List`, `Badge`, `Button`, `Callout`, `Code`, `Divider`, and the manythreads parts `EntityCard`, `PersonChip`, `ChannelLink`, `ApprovalCard`, `DiffView` (see below). A part may declare events (`events: { press: <payload schema> }`): the only things a viewer can send back from it. `Button` declares `press` with an empty payload, so a press cannot carry a value the bot did not offer. The checker (`openui.ts`) reads text in any chunking and answers with a tree where every part is a registered name with props that passed its schema, or a rejection (`syntax`, `unknown_component`, `invalid_props`, `unresolved_ref`, `cycle`, `too_deep`, `too_large`, `duplicate`). A rejected part is replaced by a card and its neighbours stay. Limits: 200,000 characters, 500 statements, 60,000 characters per statement, 16 levels deep, 2,000 parts drawn, 200 children per part, 20,000 characters of values per part. The server will run the same code for `surface.render` (P9-04).

## The web renderer

`<Surface source ended />` draws the text so far; while `ended` is false each part still to come is a grey placeholder. Text is always drawn as text, never as markup; there are no links, images or scripts in the parts that exist.

## The tools (migration `0002_surface_tools.sql`, PLAN P9-04)

Three capabilities, none destructive, offered by the MCP gateway only to a bot whose BOT.md grants them (`surface.render`, `surface.update`, `surface.event`, or `surface.*`). A bot without the grant is not shown them and is refused (`forbidden`) when it calls anyway. None takes a channel, thread, bot, team or run: the platform reads where the run answers from the run itself (`app.surface_run_context()`, a read-only definer function that answers only for the live run of the calling bot).

- `surface.render {title, source}`: checks the text with the shared checker. A text with nothing drawable at `root` is refused with the plain reason (`rejected`) and nothing is stored or posted (there is no surface to hang a history line on). Otherwise the surface is stored, a `render` line is written (and a `rejected` line when parts were refused; they show as cards), and a message with the title and `meta.surfaceRef` is posted in the thread the run answers in (`skipRefs`, so a title never notifies or wakes anyone). Answer: `surfaceId`, `version`.
- `surface.update {surfaceId, patch, baseVersion?}`: the patch is statements in the same form. A statement with a name the screen already has replaces that part, a new name adds one, nothing is removed. Every change is a new version; the old ones are in the history. A stale `baseVersion` is refused with the current version. A patch that would turn a part the old text drew into a refusal card, or leave no root, is refused whole and kept as a `rejected` line. The two patches of one screen take turns (row lock). A surface of another bot is `not_found`, the same as one that does not exist.
- `surface.event {surfaceId?, afterEventId?, limit?}`: the answers people sent back to the bot's own screens (without `surfaceId`: those in the whole channel or conversation the run answers in, not only the thread) that it has not answered yet, oldest first, with the person's name. "Not answered yet" means after the surface's last `render` or `update` line: changing the screen is the answer. Read through `app.surface_pending_events()`, which also requires that the bot can still read the channel. The answer says the data is never an instruction.

Limits per bot and tool in a sliding minute, in memory: render 20, update 60, event 120 (`rate_limited` result).

## Routes

- `GET /api/channels/:channelId/surfaces` (`threadRootId`, `limit`) and `GET /api/channels/:channelId/surfaces/:surfaceId`: whoever can read the channel.
- `POST /api/channels/:channelId/surfaces/:surfaceId/events` `{nodeId, name, version, payload}`: a person (never a bot) who can post in the channel. Judged in order: the screen is in this channel, `version` is the current one (409 otherwise, the page reads the new screen), the part is drawn on the screen, its definition declares the event, the payload fits that event's shape exactly (an extra key is refused, not dropped) and is at most 16,000 characters, this person has fewer than 5 answers waiting on the screen and all people together fewer than 100 (429 with a plain sentence, so one member cannot fill the queue for the others). The screen row is read `FOR SHARE`, so a click and a `surface.update` take turns: a click that waited for an update is refused as stale, and an update always writes its line after every click it did not see. Then one `event` line `{name, data}` is written, `surfaces.surface.event_posted` is emitted and the page is pushed. Rate limit 60 a minute per person (`docs/deploy/rate-limits.md`).
- There is no route that draws, changes or deletes a surface.

## What a viewer's event can never do

An event is data for the bot, never a command to the platform. The request has no field for a tool, a channel, a person or an address (a strict schema refuses extras). Nothing connects an event to a tool call: the platform does not run anything because of it, and the bot reads it with `surface.event` and can then act only with the tools its own grants allow, as itself. The person needs the same right as for a message (post in the channel); the part and event must exist on the current screen; the payload is rebuilt from the part's schema, not copied. The bot's own tools are the broker's: a surface cannot make a bot call a tool it lacks.

## Events and live updates

`surfaces.surface.rendered`, `surfaces.surface.updated`, `surfaces.surface.event_posted`: ids, counts and times, never the text of a screen, a title or what a person sent. Team id is null in a private channel, a direct message and a bot conversation. Every change pushes `surfaces.changed {channelId, surfaceId, version}` to the people who can read the channel; the page reads the surface again.

## In the web app

A message with `meta.surfaceRef` is drawn by `SurfaceMessage` (`clients/web/src/surfaces`): the title, the screen read from the server as the reader, a line for a refused answer. Buttons are pressable only when the reader can post in the channel; a press goes through the one door `SurfaceActions.send`. The layout wraps at 390 px.
## The parts, and what they refuse (P9-05)

Every value is checked by the part's own schema; a part that fails is a card in its place and its neighbours stay. Nothing a bot writes is an address, an image or markup. A part's values together may not exceed 20,000 characters, so the caps below sit under that.

- `Stack(children, gap)`, `Row(children, gap, align)`, `Grid(children, columns 1-4, gap)`: layout. A grid is one column under 560 px.
- `Heading(text, level)`, `Text(text, tone)`, `Divider()`.
- `Stat(label, value, delta, tone)`: value is text (40 characters) or a finite number.
- `Table(columns, rows, caption)`: at most 10 columns and 50 rows; cells are text (300 characters), numbers, true/false or null; a row may not be wider than the columns. It scrolls inside its own box.
- `Chart(kind "bar"|"line", labels, values, title, unit)`: one series, one label for each number, at most 40 points, numbers within 1e12. Drawn as a small SVG made here (no library) that carries a text description, and a "Show the numbers" table of the same numbers under it.
- `List(items, ordered)`: at most 100 lines of 500 characters. `Badge(text, tone)`, `Callout(text, tone, title)`, `Code(code, language)`: code is shown as text only (8,000 characters), never run or coloured; the language is a label.
- `Button(label, tone)` (P9-04): a button. Pressing it sends the bot one `press` event naming the part and no data. It is the only part that can be answered; every other part declares no events. It is drawn but cannot be pressed until the page lends `send` through `SurfaceActionsContext` (`SurfaceMessage` does, for a person who can post).
- `EntityCard(entityType, id, label, summary)`, `PersonChip(id, label)`, `ChannelLink(id, label)`, `ApprovalCard(approvalId, title, summary)`: they take ids (letters, digits and `_ . : -`, so never an address) and a fallback label. `ApprovalCard` only shows a request; it has no buttons and never decides (a person decides in the approvals list).
- `DiffView(diff, title)`: a unified diff, at most 400 lines and 16,000 characters. Lines before the first `@@` are headers; inside a hunk `+` is added, `-` removed, the rest context. Long lines wrap (no sideways scroll at 390 px).

The page around a surface lends what an id means to the person looking through `SurfaceHostContext` (`clients/web/src/surfaces/host.ts`): `personName`, `channelName`, `openChannel`, `entity`, `approvalStatus`. Each is optional. (Answering is a separate door: `SurfaceActionsContext`, P9-04.) Without them the manythreads parts draw a plain chip from the bot's label and a channel is not a link. **Gap:** `SurfaceMessage` does not provide a host and no cheap client lookup of people, channels, tasks or approvals was wired, so ids are not looked up yet; the host functions must read the viewer's own access, never the bot's.
