# Phase 16 retro (Connectors, Bundle D)

Sections are written by the task that did the work; the orchestrator adds the gate and the timings at phase exit. This first version is written by the last work package of Bundle D (P16-12), before the
integration pass, so everything below was proved against stand-ins only and nothing was run on the live site.

## 1. Reflect and refactor (P16-00)

Answers to PLAN Phase 16 section 0.

- **Is the OAuth flow written once, or once per provider?** Once. `packages/plugins/connections/src/oauth/` holds the flow (`flow.ts`: authorization code with PKCE, a single-use `state`, no redirect followed),
  the store, the refresh (a job every ten minutes plus the same function a tool call uses), the notice and the per-workspace app. What differs between providers is one table, `PROVIDERS` in
  `oauth/providers.ts`: whether it uses PKCE, how the client is sent (body or basic), the token body (form or JSON), the base scopes, extra consent parameters, whether it refreshes, whether it has a
  tenant or a subdomain, and whether a later sign-in keeps the earlier scopes (`incremental`). Fourteen providers were added to the table (Google, Microsoft, Notion, Jira, Linear, GitHub Issues,
  Asana, Zendesk, Intercom, HubSpot, Salesforce, Confluence, Dropbox, Box), each in about fifteen lines; none needed a copy of the flow. The three that could not use the shared revoke (Microsoft,
  Dropbox, Box) are said in the table and the code, and their sealed tokens are deleted either way.
- **Is a connector's tool list data or code?** Data. `packages/shared/src/connectors/catalog.ts` is the one list; the gallery, the broker's compile, the provider services in the plugin and the docs
  pages read it. The person sign-ins and the native kinds are generated from the provider list and `CONNECTION_KINDS`, so nothing is written twice. The catalog grew past one file, so it was split by
  the package that builds each part (`catalog-files.ts`, `catalog-chat.ts`, `triggers.ts` for which triggers are on); the split was made so two coders never edit the same lines. A catalog test
  refuses a trigger id that names nothing and a tool in the plugin that the catalog does not list.
- **Provider quotas: does each source have its own rate limit, or do all share one?** There is no per-provider budget, and the honest answer is that none was built. What exists: the answer cap
  and the timeouts on each outbound door (the connections source, the bridges door: constant host, no redirects, 10 seconds, 256 KB); the chat services' 429 is retried after `Retry-After`
  (bridge sends retry up to 3 times); Slack's `Retry-After` and Telegram's `retry_after` are honoured; Linear's rate-limit error is turned into "slow down"; knowledge reads stop after three
  failed answers in a pass and take 100 documents and 20 MB per pass; a bot is capped at 30 webhook runs an hour; the public doors have address limits (see `docs/deploy/rate-limits.md`);
  and the daily counters (`connection_usage_daily`) show an admin when failures climb. What is missing is a shared back-off per provider across tools, and quota-aware paging; it is a later task
  once a real account shows what each provider's limits are.

## 2. What phase 16 delivered (Bundle D)

- **Contracts first** (P16-12 contracts, A, then H, C, D1, D2, B1, B2 in parallel in one tree with disjoint files): migrations connections 0006, webhooks 0004 and 0005, meetings 0005, notifications 0007,
  knowledge 0005, bridges 0001; the SDK connector kinds `provider.connector.calendar` and `provider.connector.documents`; the events of the bundle (ids and counts only).
- **Stand-ins** (`tools/fake-saas`): one process with a control port that hosts Google, Microsoft, Notion, the trackers, the support apps, Telegram, WhatsApp, Slack, Teams, Confluence, Dropbox, Box and a
  signed-webhook sender (with tamper modes). It refuses to start in production.
- **People:** planned rooms with a calendar event, a reminder five minutes ahead and a join page; free time for Brain; documents from seven apps into a base under the team rule; four chat apps; the
  admin health and People pages; offboarding that fails closed.
- **Docs:** one page for each of the 18 connectors in `docs/connectors/`, ending in what was proved against the stand-in only.
- **Seed:** `MANYTHREADS_STACK_SEED=connectors` (opt-in) makes a demo of the bundle; `seedWorld` alone never does.

## 3. Mistakes added to MISTAKES.md

- Message text such as "(#100)" trips the `no-raw-hex` lint rule.
- A raw U+2028 or U+2029 in one plugin's regex literal fails every server integration test, because they all load every plugin (write the `\u` escapes).
- An integration test cannot let a fake chat service call the server back through `publicUrl` (the fixed `http://localhost:3000`); post to `server.url`, or start the server on a free port with `publicUrl` set to it.
- A new `app.connections` row defaults to `disabled`.
- A partial commit of a shared file needs hunk-level staging.
- `fake.reset()` on a fake provider wipes its files and accounts; clear a forced failure with `failNextApi(status, 0)`.
- A React portal still bubbles submit events to an enclosing form, so render the button outside the form.
- A fake must carry the provider's documented limits, or the code under test never meets them.

## 4. Not done, carried on

- Nothing has run against a real provider. Each connector page lists what only a real account can show; the first connection of each is the live check. Q2 (no real accounts) decides this.
- The integration pass: gates, vitest per project, one Playwright run of the new specs, the 48 plates viewed and baselined, a stage release for the probe's block B, then the probe against production.
- Gmail and Outlook "new mail" triggers (a run started by mail has no asker; an owner decision), Freshdesk (personal API key), the two-way tracker mirror, the Meet and Teams transcript imports, tools
  for Confluence, Dropbox and Box, Intercom's EU and Australia regions, Salesforce sandboxes, group shares in a team base (Q4).
- A per-provider call budget and back-off (see section 1).
- The wrong-code lockout and Microsoft's key cache are per server replica.
