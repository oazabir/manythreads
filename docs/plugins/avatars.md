# avatars

The profile picture of a person, and the picture of a bot. A person picks one of the built-in pictures, uploads a photo of their own, or picks nothing; a bot has one of the built-in bot
pictures or nothing. **When nothing is picked the web app draws the initials** on a coloured disc, as it always did. Code: `packages/plugins/avatars` (the person's routes),
`packages/plugins/bots` (the bot's route), `packages/shared/src/entities/avatar.ts` (the catalogue of pictures and the value's shape), `api/avatars`. The pictures are files of the web client,
`clients/web/public/avatars/<id>.webp` (160 pixels, 40 files, about 220 KB in all). Credits: [third-party-assets](../third-party-assets.md).

## What a person sees

- **Choosing:** *Account* page → *Picture* → *Change picture*; the account menu's *Profile picture…*; and *Change picture* on their own profile card. One dialog: the current picture, *Upload a
  photo*, *Use initials*, then the built-in pictures in three groups — **Men** (10), **Women** (5) and **Women with a hijab** (5). A choice is saved the moment it is pressed.
- **A photo** is cut to its centred square and shrunk to 256 pixels by the browser before it is sent (WebP, or JPEG where the browser cannot write WebP), so a phone photo of several megabytes
  arrives as a few kilobytes. A file that is not a picture, or is an SVG, is refused in words.
- **Bots:** on the bot's page a team lead or a workspace admin sees *Change picture* and chooses among the **20 bot pictures** (cats, dogs, unicorns, a panda, a penguin …), or *Use initials*.
  Bots have no photo upload. The picture is not part of `BOT.md`, so choosing it is not a proposal and does not change the bot's definition.
- **Where it shows:** every place that draws a person or bot — messages, the roster, direct messages, the profile card, the bot roster and page, a bot conversation, the account menu. A person's
  own change shows at once on their screen; other people see it the next time their client loads the team's roster (a page load). A picture that cannot be loaded falls back to the initials.

## What is stored

One short text, `people.avatar` / `bots.avatar` (kernel migration `0015`, bots migration `0019`): `preset:<id>` for a built-in picture, `photo:<16 hex>` for an uploaded photo (the start of its hash,
so a new photo has a new address and an old one is never shown from a cache), or empty. A column `CHECK` holds the shape; for a bot the id must start with `bot-`. The roster
(`GET /api/teams/:slug/roster`), the bot roster and `GET /api/session` carry the value; nothing else is added to them.

The photo bytes are one row per person in `person_photos` (at most 256 KiB, PNG, JPEG or WebP, enforced by a `CHECK` too). Row-level security: a person writes and deletes only their own row;
every non-guest member of the workspace may read every row, a guest only their own. Choosing a built-in picture or *Use initials* deletes the person's photo.

## Routes

| Route | Who | What |
|---|---|---|
| `PUT /api/me/avatar` `{ preset }` | the signed-in person | Choose a built-in picture from the three people groups (a bot picture or an unknown id is `400`). Removes a photo. |
| `PUT /api/me/avatar/photo` `{ contentType, data }` | the signed-in person | Upload a photo (base64). See the rules below. |
| `DELETE /api/me/avatar` | the signed-in person | Back to the initials. |
| `GET /api/people/:personId/avatar` | any member who can see the person | The photo's bytes. `404` when there is none or the reader may not see it; `304` for a repeat with the `etag`. |
| `PUT /api/teams/:slug/bots/:botSlug/avatar` `{ preset \| null }` | lead of the team or workspace admin (bots plugin) | Choose a bot picture, or `null` for the initials. Done through the function `app.bots_set_avatar`, which checks the caller. |

## The rules for a photo

Checked on the server, never trusted from the browser: at most 256 KiB; the **first bytes** say what it is (PNG, JPEG or WebP — an SVG, which can carry script, or anything else is refused) and must
agree with the declared type; the **size its own header declares** is read without decoding and a photo over 1024 pixels on a side (or one whose header cannot be read) is refused, because every
other person's browser would have to decode it. The photo is served with `nosniff`, `cross-origin-resource-policy: same-origin`, a sandboxing content-security-policy and `private` caching; the address
carries `?v=<hash>`. The upload route is limited to 20 a minute per person. There is no event: a picture is not audited content.

## Not done

Other people's clients do not update live when someone changes a picture (no push); a picture shows up for them on the next roster load. Git commit authors in the file history and the author of a
saved message in *Later* still show initials.
