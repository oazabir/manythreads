# P36-03 · Meetings without a channel

Owner, 2026-11-23: "channel-independent meeting creation at any time, where people can be invited to join that meeting regardless of the channel" and
PLAN P36-03: "start or plan a meeting at any time with invited people from any team; it gets its own private meeting thread for its card, notes and transcript
(a channel of kind `meeting` whose members are the invited)". P36-04..07 (the team schedule and appointments) build on it: an appointment's Join opens its
meeting space.

## 1. What a meeting space is

A channel of a new kind, **`meeting`**:

- **no team** (`team_id` NULL, as a direct message): its people may come from any team of the workspace;
- **private**, its **members** are the person who made it and the people invited (at most 100, `CALL_INVITES_MAX`); never a guest; never a bot (the note-taker
  joins the call, not the channel, as today);
- **titled**: the title lives in `purpose` (a meeting has no `#name`; `name` is `''` as for a DM); the owning team for its files is the maker's chosen team
  (`meeting_team_id` below), only for where its notes and transcript are kept;
- one per meeting: a new meeting is a new space (unlike a DM, which is one per set of people), so its card, chat, notes and transcript are its own.

Visibility needs **no change** to `app.visible_channel_ids`: a person sees a team-less channel they are a member of (the `channel_members` path already admits
`c.team_id IS NULL`), a bot sees nothing of it, a guest is excluded by the same rule as a DM.

## 2. Data

Channels migration: `kind IN ('channel', 'dm', 'bot_conversation', 'meeting')`, `ChannelKind` gains `meeting`, a check that a meeting has no team and no
`dm_key`/`bot_id`. Meetings migration: `app.meetings_open_space(p_title, p_team_id, p_person_ids uuid[]) RETURNS uuid` (definer, owned by the system role, as
`dm_open`): the caller is a person (not a guest) on `p_team_id`; every invited id is an active non-guest person of the workspace; at most 100; inserts the
channel and its members in one statement. `app.meeting_spaces (channel_id PK, team_id, created_by, created_at)` keeps the owning team.

## 3. Routes and flows

- `POST /api/meetings/spaces {title, teamSlug, kind: audio|video, inviteeIds}` → opens the space and starts the call in it (`startRoom` with the invitees: the
  push, inbox item and ring of P15-27 come with it); the answer is the meeting and the join token, as the start route's.
- `GET /api/meetings/spaces` → the spaces the person is in, newest first, with the live call if any (the sidebar).
- Planning ahead is P36-06: an appointment holds the invitees and, at its time, opens (or reuses) its space.

## 4. Each place that decides by kind (reviewed one by one in the build)

Treated **as a DM** unless said: no team (so no bots, no team repo, no mention groups), private, members only.

| Place | What `meeting` does there |
|---|---|
| `channels` 0001 CHECK, `ChannelKind`, `toChannel` | allowed; `purpose` is its title |
| `channels/routes-messages.ts`, `routes-scheduled.ts`, `routes-polls.ts`, `routes-drafts.ts`, `service.ts` | posting, scheduling, polls and drafts as in a DM |
| `channels` mentions / role groups | none (no team), as a DM |
| `runtime-hermes` router (`router-subscribe`, `router-chat`, `router-personal-routines`, `activity-routes`, `0009_channel_watchers`) | no bot is woken (no team), as a DM |
| `conversations/*`, `answer/0003`, `bots/0026` | bot conversations only; `meeting` is not one |
| `link-preview` jobs and routes | as a DM (members only) |
| `meetings/writer.ts`, `notetaker-notes.ts` | notes and transcript under the owning team's files `meetings/<date>-<title>/` (from `meeting_spaces.team_id`), or the space's own files folder `meetings/<id>/` when the team is gone |
| `search` | members only, as a DM; the result names the meeting's title |
| web `shell/messageLink.ts`, sidebar, `ChannelView` header | a "Meetings" group in the sidebar under Direct messages (title, live dot); the header shows the title and the people; the call card as anywhere |

## 5. Tests

RLS: a member reads it, a person not invited and a guest do not, a bot does not. Routes: open with people from two teams; at most 100; a guest cannot be
invited; the call starts in it with the invitations. Web: the New meeting dialog (title, team, kind, people from any team), the sidebar group. Browser: Nadia
opens a meeting with Priya (another team), Priya sees it under Meetings and joins.

**Changed by P37-04 (owner, 2026-11-25):** the sidebar group is gone. Meetings is one plain sidebar entry that opens `/t/<team>/meetings`: the list of spaces on the left (newest first, live dot, people), "New meeting" at its top, and the selected space's chat on the right (`/t/<team>/meetings/space/<channel>`; on a phone the list is the page and a space opens full screen with a way back). `/t/<team>/meeting/<channel>` still works and redirects.
