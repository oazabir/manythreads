# avatars

The profile picture of a person, and the picture of a bot. A person picks one of the built-in pictures, uploads a photo of their own, or picks nothing; a bot has one of the built-in bot
pictures or nothing. **When nothing is picked the web app draws the initials** on a coloured disc, as it always did. Code: `packages/plugins/avatars` (the person's routes),
`packages/plugins/bots` (the bot's route), `packages/shared/src/entities/avatar.ts` (the catalogue of pictures and the value's shape), `api/avatars`. The pictures are files of the web client
in `clients/web/public/avatars/`: the library of 50 sharp-at-any-size SVG pictures, `<id>.svg`, and the 40 WebP pictures of the first library, `<id>.webp`, kept only so that a picture someone already chose keeps drawing.
Credits and licences: [third-party-assets](../third-party-assets.md).

## The picture library

**50 pictures are offered**, all SVG (`packages/shared/src/entities/avatar.ts` lists them, each with a plain-words label used as its alt text and tooltip):

- **People (25):** *Men* (15: `man-20-casual` … `man-60-formal-shaven`), *Women* (5: `modest-20-formal` … `modest-60-formal`) and *Women with a hijab* (5: `hijab-20-casual` … `hijab-60-casual`). DiceBear's Avataaars style.
- **Bots (25):** *Bots* — 19 animals (`bot-noto-bear` … `bot-noto-tiger`, Google Noto Emoji) and *Brain* — 6 pictures made for this project (`bot-brain`, `bot-brain-chip`, `bot-brain-circuit`, `bot-brain-glow`, `bot-brain-neural`, `bot-brain-orb`).
  Any bot may use a Brain picture; nothing is reserved.

An id is never renamed once released. The **40 pictures of the first library** (`man-1`, `bot-kitty-1` …, Flaticon, WebP) stay valid: whoever chose one keeps it and it keeps drawing, but no picker offers it
and the routes refuse it as a new choice (`400`).

## What a person sees

- **Choosing:** *Account* page → *Picture* → *Change picture*; the account menu's *Profile picture…*; and *Change picture* on their own profile card. One dialog: the current picture, *Upload a
  photo*, *Use initials*, then the built-in pictures in three groups — **Men** (15), **Women** (5) and **Women with a hijab** (5) — and a credit line. A choice is saved the moment it is pressed.
- **A photo** is cut to its centred square and shrunk to 256 pixels by the browser before it is sent (WebP, or JPEG where the browser cannot write WebP), so a phone photo of several megabytes
  arrives as a few kilobytes. A file that is not a picture, or is an SVG, is refused in words.
- **Bots:** every bot has a picture from the moment its row exists (below). On the bot's page a team lead or a workspace admin sees *Change picture* and chooses among the **19 animals** and the **6 Brain pictures**,
  or *Use initials*. **Brain's picture can be changed only by a workspace admin** (the page hides the button from a lead who is not one; the server refuses with `403` either way).
  Bots have no photo upload. The picture is not part of `BOT.md`, so choosing it is not a proposal and does not change the bot's definition.
- **Where it shows:** every place that draws a person or bot — messages, the roster, direct messages, the profile card, the bot roster and page, a bot conversation, the account menu. A person's
  own change shows at once on their screen; other people see it the next time their client loads the team's roster (a page load). A picture that cannot be loaded falls back to the initials.

## A picture for every new bot

When the bots plugin's loader first creates a bot's row (from `bots/<slug>/BOT.md`), in the same transaction it gives the row a picture: **`bot-brain-chip` for Brain** (slug `brain`), otherwise **one of the 19 animals at
random** (never a Brain picture). The random source is injectable (`setBotAvatarRandom` in `packages/plugins/bots/src/avatar.ts`) so tests are exact. The picture is **never re-rolled**: it is asked for only when the row
does not exist yet, and the loader's update on a reload does not name the column, so an edit of `BOT.md`, a choice a person made and a deliberate *Use initials* all stay. This covers every way a bot appears,
because every one of them ends in a `BOT.md` commit the loader reads: template bots when a team is created, a bot added in the repo, the Add a bot helper and the seeds.

**Migration `0021_bot_avatar_library`** gives every existing bot **with no picture** one — Brain the chip, any other bot an animal picked from the md5 of its id, so running it again gives the same answers — and touches no bot
that already has a value. It also tightens `app.bots_set_avatar`: for Brain only a workspace owner or admin passes (a team lead alone does not).

## What is stored

One short text, `people.avatar` / `bots.avatar` (kernel migration `0015`, bots migration `0019`): `preset:<id>` for a built-in picture, `photo:<16 hex>` for an uploaded photo (the start of its hash,
so a new photo has a new address and an old one is never shown from a cache), or empty. A column `CHECK` holds the shape; for a bot the id must start with `bot-`. The roster
(`GET /api/teams/:slug/roster`), the bot roster and `GET /api/session` carry the value; nothing else is added to them.

The photo bytes are one row per person in `person_photos` (at most 256 KiB, PNG, JPEG or WebP, enforced by a `CHECK` too). Row-level security: a person writes and deletes only their own row;
every non-guest member of the workspace may read every row, a guest only their own. Choosing a built-in picture or *Use initials* deletes the person's photo.

## The person's look

Beside the picture, the plugin keeps two more settings of the person's own row (kernel migration `0017`): `people.theme` (`system`, `light` or `dark`; `system` follows the device) and `people.density` (`comfortable` or `compact`).
Both start as `system` and `comfortable`. `GET /api/session` carries them as `person.appearance`, so a new browser or device draws the same way as the last one; the web client draws them as
attributes on `<html>` and keeps a copy in the browser so the next first frame is right (Account → Appearance; `clients/web/src/shell/appearance.ts`). The shared shape is `Appearance` in `packages/shared/src/entities/appearance.ts`.
A person writes only their own row (the existing `people_update` policy).

## Routes


| Route | Who | What |
|---|---|---|
| `PUT /api/me/avatar` `{ preset }` | the signed-in person | Choose a built-in picture from the three people groups (a bot picture, a picture of the first library or an unknown id is `400`). Removes a photo. |
| `PUT /api/me/avatar/photo` `{ contentType, data }` | the signed-in person | Upload a photo (base64). See the rules below. |
| `DELETE /api/me/avatar` | the signed-in person | Back to the initials. |
| `PUT /api/me/appearance` `{ theme?, density? }` | the signed-in person, a guest too | The person's look (see below). A field left out keeps its value; an unknown value, field or an empty body is `400`. Answers `{ theme, density }` as stored. No event and no audit row: it is a preference. |
| `GET /api/people/:personId/avatar` | any member who can see the person | The photo's bytes. `404` when there is none or the reader may not see it; `304` for a repeat with the `etag`. |
| `PUT /api/teams/:slug/bots/:botSlug/avatar` `{ preset \| null }` | lead of the team or workspace admin; for Brain, workspace admin only (bots plugin) | Choose one of the 25 bot pictures, or `null` for the initials. Done through the function `app.bots_set_avatar`, which checks the caller. |

## The rules for a photo

Checked on the server, never trusted from the browser: at most 256 KiB; the **first bytes** say what it is (PNG, JPEG or WebP — an SVG, which can carry script, or anything else is refused) and must
agree with the declared type; the **size its own header declares** is read without decoding and a photo over 1024 pixels on a side (or one whose header cannot be read) is refused, because every
other person's browser would have to decode it. The photo is served with `nosniff`, `cross-origin-resource-policy: same-origin`, a sandboxing content-security-policy and `private` caching; the address
carries `?v=<hash>`. The upload route is limited to 20 a minute per person. There is no event: a picture is not audited content.

## Not done

Other people's clients do not update live when someone changes a picture (no push); a picture shows up for them on the next roster load. Git commit authors in the file history and the author of a
saved message in *Later* still show initials.
