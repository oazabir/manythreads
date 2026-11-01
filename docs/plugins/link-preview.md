# link-preview

link-preview shows a small card under a message that carries a web link: the site, the page's title, a short description and a picture. The server reads the page itself, so the card
looks the same for everyone who can read the message, and the browser never contacts the linked site (so the site learns nothing about who read the message, and a tracker in
the picture's address cannot reach the reader). PLAN P14-08. It is built to be safe with addresses any member can type; the rules for that are the heart of this page.

Not in scope: rich cards that know a service (an issue from a tracker, a pull request, a shared document). Those are separate work. A link dropped into the team inbox is **never** read (PLAN D6): a dropped
document is not a channel message, and nothing in this plugin looks at it.

## How a card is made

0. **The switch.** `MANYTHREADS_LINK_PREVIEW` (`on`/`off`; also `1`, `0`, `true`, `false`, `yes`, `no`). Unset means **on in production and development, off when `NODE_ENV=test`**, and the e2e stack sets it to `off`, so no test posts a link and finds a
   background job reading a page. The plugin's own database tests set it to `on` for their run. It is read at every job, so a running server obeys a change of the variable on the next job. Off means: no job is queued, a queued job ends at once, and the list route answers `enabled: false`.
1. A message is posted or edited. The plugin's subscriber (`channel.message.posted`, `.edited`, `.deleted`) queues a job `link-preview.sync` for it.
2. The sync job reads the message text, takes the links out (bare links and the address part of `[label](address)`; not inside code; at most 5 per message), removes the **live** cards of links that are no longer in the text (never a tombstone: the row of a card its author removed
   stays, so the same link written again stays without a card) and queues one `link-preview.fetch` job per link. When previews are off for the workspace it does neither.
3. A fetch job reads the page (see "The safe fetch" below), then the page's oEmbed endpoint when the page's own tags lack a title or a picture, then the picture. It stores a card under the message and tells everyone who can read the channel
   (realtime push `link-preview.changed`), so the card appears without a reload.
4. The same address is read at most once a day per workspace (an hour when the read failed or was refused, five minutes when the site was cooling down): the result is kept in a cache. A card is a copy, so an old message keeps its card after the cache row expires.
   A kept result saves only the network: the address still goes through the workspace rules and the `pre_egress` chain before it becomes a card.

**No transaction is open while the network is read.** A fetch job is `detached`: it opens a short transaction to look at the message and the rules, closes it, reads the page (up to 8 seconds, the whole job), and opens a second short transaction to write.
The second one looks again: the card is written by one `INSERT ... SELECT` from `app.messages` that finds nothing unless the message is **not deleted and still has exactly the text the job read**. An edit or a delete that committed during the read therefore
leaves no card, and the rules are loaded again there too (a site denied meanwhile gets no card).

**Limits on how much is started.**

- Per author 10 new reads a minute and 60 an hour, per workspace 400 an hour (like the mention budget of the channels plugin; in memory of the process). Only links that need the network count: a link that already has a card, or a kept read of the last day, is free. A message over
  the budget gets no card for the links it could not afford and a line in the log; nothing is queued for them.
- One fetch job per workspace at a time (`serialKey: workspaceId`), two in the process, so one busy workspace cannot take every worker.
- A host that timed out or could not be reached three times in a row is not asked again for five minutes (`host_cooling`, kept as a failed read for five minutes). A 404 or a page with no tags does not count: the site is answering.
- One deadline of 8 seconds covers a job that reads a page, an oEmbed endpoint and a picture one after the other; no read runs past it.

A conversation with a bot gets no cards, and neither does a deleted message. Editing a message to drop a link drops its card; a card the author removed stays removed, even after an edit that keeps the link.

*What the page says.* Open Graph tags (`og:title`, `og:description`, `og:image`, `og:site_name`), Twitter-card tags, the plain `<title>` and `description`, and an oEmbed endpoint named by `<link rel="alternate" type="application/json+oembed">`.
Only text and one picture address are taken; the `html` member of an oEmbed answer is never used. All text is plain: character references decoded once, control, direction-changing and zero-width characters removed, cut to 200 / 400 / 100 characters.
The client shows it as text, never as markup.

## The safe fetch (`src/safe-fetch.ts`)

The server connects to an address a member typed, which could point at the server's own network (this attack is called SSRF, server-side request forgery: the cloud metadata service at `169.254.169.254`, the database, an admin page on the cluster). Every read
goes through one function, and each rule below has a test.

| rule | what it does |
|---|---|
| scheme and port | only `http` and `https`; only port 80 and 443 (and a scheme's own default); `ftp:`, `file:`, `data:`, `javascript:` and every other port are refused |
| credentials | a user name and password in the address are dropped and never sent (`https://me:secret@host/` is read as `https://host/`); the fragment is dropped too |
| local names | `localhost`, `*.localhost`, `*.local`, `*.internal`, `*.localdomain`, `*.home.arpa` are refused before any lookup |
| which addresses | resolved **once**; **every** answer must be a public address, so a name with one private answer is refused whole. Refused: `0/8`, `10/8`, `100.64/10` (shared/CGNAT), `127/8`, `169.254/16` (link-local, the metadata address), `172.16/12`, `192.0.0/24`, `192.0.2/24`, `192.88.99/24`, `192.168/16`, `198.18/15`, `198.51.100/24`, `203.0.113/24`, `224/4`, `240/4`; in IPv6 everything outside `2000::/3`, plus documentation, Teredo and benchmarking ranges, NAT64 (`64:ff9b::/96`), 6to4 whose embedded IPv4 is private, and IPv4-mapped or -compatible forms (`::ffff:127.0.0.1` is judged as `127.0.0.1`). Zone ids (`%eth0`), octal, hex and integer spellings of an IPv4 address are not addresses |
| rebinding | the socket is opened to the **vetted address itself** (an IP literal), with the name in the `Host` header and in the TLS server-name check. There is no second lookup that could answer differently |
| redirects | at most 3; each one is a new request that passes every rule again (scheme, port, name, addresses) and the workspace check, so `Location: http://169.254.169.254/` stops there |
| size | counted while the bytes arrive: a page is cut at 1 MiB (the tags we want are near the top), an oEmbed answer at 256 KiB, a picture is refused above 512 KiB. Compressed answers (`gzip`, `deflate`, `br`) are counted **after** expanding, so a small file that expands to gigabytes is cut at the limit. `deflate` is read in both forms: the zlib one the standard names and the raw one many servers send (the first two bytes tell which) |
| time | one clock of 3 seconds per read covers the lookup, the connection, every redirect and the body, and never runs past the deadline of the whole job (8 seconds); a server that never answers or drips a byte at a time is dropped |
| names | the lookup does **not** use `dns.lookup` (it runs on libuv's four shared threads and cannot be cancelled, so a few dead names could stall every file read and password hash of the server). It uses the c-ares resolver (`dns.promises.Resolver`) with a 1.5 second timeout and one try, at most **2 lookups at once** (64 may wait, the rest are refused at once), one shared lookup for callers of the same name, a caller that gives up leaves the line, and a name that failed is remembered for 30 seconds (`src/resolver.ts`) |
| content | the page must be HTML (or say nothing about its type); the oEmbed answer JSON; a picture is judged by its **first bytes**, never by the type the site declared |

A refusal carries a short code (`blocked_scheme`, `blocked_port`, `blocked_host`, `blocked_address`, `blocked_by_policy`, `host_cooling`, `dns_failed`, `too_many_redirects`, `bad_redirect`, `timeout`, `too_large`, `bad_status`, `bad_type`, `bad_encoding`, `network`). It is kept in
the cache row and the log, never shown to members, and never contains page text.

The same rules are applied to the picture's host and the oEmbed endpoint's host, which come from the page and are just as hostile as the link.

## Pictures (the proxy)

The picture is stored in `link_preview_images` after its first bytes were checked: **PNG, JPEG, GIF, WebP or AVIF only**. SVG (which can carry script), HTML, icons and everything else are not pictures here, however the site names them. A table `CHECK`
repeats the list and a 512 KiB cap (a card shows the picture at 88 pixels). A small file can still decode to a huge bitmap, so the **size the picture declares is read from its own header** (PNG, GIF, JPEG, WebP and AVIF; no decoding) and a picture over 4096 pixels on
a side or 16 million pixels in all, one of no area, or one whose header cannot be read, is not kept (the card is made without it). A workspace keeps at most **128 MiB** of pictures: past that, the oldest pictures no card uses are dropped first, and when that is
not enough the new card has no picture. `GET /api/link-previews/:previewId/image` serves the bytes from this server:

- access follows the card: you can read it if you can read the message's channel, and a removed card or a deleted message has no picture; it is also judged by the **workspace's rules as they are now**, so a site denied today has no picture today;
- the bytes are checked against the stored type again on every request;
- headers: the sniffed `Content-Type`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cross-Origin-Resource-Policy: same-origin`, `Content-Disposition: inline`, an `ETag`, and `Cache-Control: private, max-age=0, must-revalidate`.
  The browser may keep the bytes but asks again every time; an unchanged picture is answered `304` (so access is decided on every request, and a removed card or a new rule takes effect at once, not after ten minutes).

## Workspace rules

`/api/admin/link-previews` (owners and admins; `GET` and `PUT`): `enabled`, and two lists of host names, `allow` and `deny`. A host on a list also covers its subdomains (`example.com` covers `docs.example.com`, not `badexample.com`). **Deny wins**; a **non-empty allow list closes
everything it does not name**. With `enabled: false` nothing is read. Entries are cleaned like the egress lists (a pasted address loses its scheme and path); at most 200 each.

**A rule is not only for the future.** When a save changes the switch or a list, the route queues a sweep (`link-preview.sweep`, one per workspace at a time) that deletes the cards and kept reads whose address no longer passes (every card when the switch is now off; a tombstone is left,
it holds no content). Until the sweep has run, the card list and the picture route judge each card's **address** against the rules on every request, so a card of a denied site is neither listed nor served from the first moment. Every member can read the rules (the
database allows it, so those routes can judge); only the settings route's `GET` stays for admins.

A change is written to the audit log: `PUT` emits `linkpreview.settings.updated` (the switch, and how many sites are allowed and blocked, before and after; no host names) inside the same transaction, and the [audit plugin](./audit.md) shows it as "Changed link previews"
(category settings). A save that changes nothing records nothing.

Every address the fetcher is about to request (the page, each redirect, the oEmbed endpoint, the picture) also passes the `pre_egress` chain with destination `link_preview` ([guardrails-egress](./guardrails-egress.md), [guardrails-dlp](./guardrails-dlp.md)). So the
**air-gapped** preset reads nothing, **strict-egress** reads only allow-listed hosts, and the data-loss check reads the address itself (a secret pasted in a query string is not sent to a third party). When nothing guards the destination, the fetch is refused. The call carries the **team** of the message's channel (so the team's own list of reachable hosts applies) and `recorded: false`: the guardrails plugins write their own refusal to
the audit log, which is how a refused link shows there (a link is not a `guardrails.egress.decided` event of its own). The chain runs in a short transaction of its own, so a refusal's audit line stays even though the read goes on to fail.

## Tables (migrations `0001_link_previews.sql`, `0002_hardening.sql`)

| table | holds | who |
|---|---|---|
| `link_previews` | the card of one link of one message (title, description, site name, picture id, `removed_at` tombstone) | read with the message's channel (`app.visible_channel_ids('read')`); the **author** of the message, a **manager of its channel** (the lead of its team) and a **workspace owner or admin** may set `removed_at`/`removed_by` and nothing else; the job creates and deletes |
| `link_preview_images` | picture bytes | read only through a card the caller can read; written by the job |
| `link_preview_cache` | what the server read from one address, per workspace, one day (one hour for a failure) | **system only**: it is keyed by address, so listing it would show which addresses were posted in private channels |
| `link_preview_settings` | on/off and the two lists | read by every member of the workspace, written by owners and admins |

## Routes

| route | notes |
|---|---|
| `GET /api/channels/:channelId/link-previews?messageIds=a,b,c` | the cards of up to 100 messages of one channel (the message list asks for a screenful at once); 403 for a channel the caller cannot read. Answers `{ items, pending, enabled }`: `pending` lists the asked messages (posted in the last 30 seconds) that carry an allowed link and have no card yet, `enabled` is false when the server's switch or the workspace's switch is off |
| `GET /api/channels/:channelId/messages/:messageId/link-previews` | the cards of one message |
| `DELETE /api/channels/:channelId/messages/:messageId/link-previews/:previewId` | the author, a manager of the channel or a workspace admin takes one off (403 for anyone else; an abusive card on somebody else's message can be removed by the people who run the place); answers `{ removed }` |
| `GET /api/link-previews/:previewId/image` | the picture (see above) |
| `GET`/`PUT /api/admin/link-previews` | the workspace rules |

A card in a response has `host` (the site's host name without `www.`, taken from the address, never from the page), `title`, `description`, `siteName` (what the page calls itself: an attacker chooses it), `hasImage` and `canRemove`; it never carries the picture's address, so a third-party address cannot reach a response.

## Realtime

`link-preview.changed` `{ channelId, messageId }` goes to everyone who can read the channel when a card is made, pruned or removed. It is a hint: the client asks for that message's cards again.

## The web client

`clients/web/src/linkpreview/`: a store that batches the asks of one moment into one request per channel (up to 100 messages), a `LinkPreviewCards` component under the message's attachments, and the push listener. A row keeps a 96 px slot only when the server says a card is coming (the message is in `pending`), for at most 20 seconds, and never when the feature is off: on `enabled: false` the store stops asking for five minutes and holds no slot, so a server with the feature off has no layout shift. A card has a fixed height and a fixed picture slot (88 px, 64 px under 480 px), so neither the answer nor a late picture moves the rows below. A card made after the first answer (the server reads the page a moment after the message is posted) fades in;
the row grows once. The card shows the **real host first** and the page's own site name second (`example.com · Totally Official Bank`), never the site name alone, so a page cannot pass itself off as another site.
The remove button shows for whoever `canRemove` says (always on touch screens, on hover or focus elsewhere), the link opens in a new tab with `rel="noopener noreferrer nofollow"` and no referrer.

## Not done on purpose

- Rich service cards (issues, pull requests, documents), and a settings screen: the route exists, the web screen does not.
- One page read per link, with no retry inside the hour for a failed one; a member who fixes a link edits the message.

## Tests

`test/resolver.test.ts`: the bounded lookup (two at a time, the line, giving up, the memory of failed names; a guard that `safe-fetch.ts` never calls `dns.lookup`). `test/limits.test.ts`: the switch, the budget, the host breaker. `test/image-size.test.ts`: the size read from each picture kind and the limits, hostile headers.
`test/jobs.test.ts`: the jobs against a scripted database (feature off queues nothing, no transaction open during the network, the guard asked again for a kept read with the team, the conditional insert, the budget, the sweep, the byte cap). `test/address.test.ts`: every blocked range and its neighbours, IPv6 forms, spellings that must not parse. `test/safe-fetch.test.ts`: the table of refused addresses, a fake resolver and a fake local server (private and mixed answers, rebinding, redirects to the
metadata address, to another port or scheme, the redirect cap, credentials never sent, byte caps, a gzip bomb, both forms of deflate, timeouts, the job deadline, a slow drip). `test/parse.test.ts`: hostile HTML (scripts, comments, unclosed quotes, entity tricks, huge input timed with `expectLinear`), oEmbed, image sniffing. `test/links.test.ts`:
link extraction and the allow/deny rules. `test/fetch-preview.test.ts`: a card from page, oEmbed and picture end to end against a fake server. `test/migration.test.ts`: the migration text. `test/rls/link-preview-rls.test.ts` and `test/link-preview-api.test.ts` need the database.
Client: `clients/web/test/link-preview.test.ts`.
