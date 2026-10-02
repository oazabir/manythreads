import type { SeedAuthor } from './seed-data.ts';
import type { TeamName } from './personas.ts';

// The words of seed v4 (PLAN P4-13): what each template team's repo holds after seeding. Text only: attachments (PDF, PNG, MP4, Office)
// go to channel folders through the storage provider (seed-repo.ts), never into git. Colours are written as rgb(): the lint bans raw hex.

export interface RepoStep {
  /** Who commits. `system` is the built-in routine that writes `memory/journal/`. */
  actor: SeedAuthor | 'system';
  /** Unique in the team's history: the idempotency key (a step whose message is already a commit of the team is skipped). */
  message: string;
  files: { path: string; content: string }[];
  /** Other contributors, as `Co-authored-by` trailers. */
  coAuthors?: SeedAuthor[];
}

interface TeamVoice {
  team: TeamName;
  slug: string;
  /** People: the two who edit the runbook, the one who keeps the reports, the team lead (or an admin) who owns `bots/`. */
  a: SeedAuthor;
  b: SeedAuthor;
  reports: SeedAuthor;
  lead: SeedAuthor;
  runbook: { title: string; v1: string; v2: string };
  bot: { slug: string; name: string; role: string; trigger: string };
  fact: { topic: string; title: string; body: string };
  facts2: { topic: string; title: string; body: string };
  journal: string;
  dispatch: string;
}

const VOICES: TeamVoice[] = [
  {
    team: 'Engineering',
    slug: 'engineering',
    a: 'rafi',
    b: 'nadia',
    reports: 'priya',
    lead: 'omar',
    runbook: {
      title: 'Production deploy runbook',
      v1: `# Production deploy runbook

How we ship to production. Keep it short; the release owner reads it before every deploy.

## Before you start

1. CI is green on \`main\`.
2. The release owner has posted the plan in #releases.
3. Nobody is mid-incident (check #incidents).

## Deploy

1. Tag the release: \`git tag v2.14.0\`.
2. Run \`deploy production v2.14.0\`.
3. Watch the dashboards for ten minutes.
`,
      v2: `# Production deploy runbook

How we ship to production. Keep it short; the release owner reads it before every deploy.

## Before you start

1. CI is green on \`main\`.
2. The release owner has posted the plan in #releases.
3. Nobody is mid-incident (check #incidents).
4. It is not a freeze window (see \`memory/facts/deploy-freeze.md\`).

## Deploy

1. Tag the release: \`git tag v2.14.0\`.
2. Run \`deploy production v2.14.0 --canary 10\`.
3. Hold the canary at 10% for 30 minutes. Compare the error rate and p95 latency with the previous release.
4. Promote to 100% with \`deploy promote v2.14.0\`.

## Rollback

If the error rate doubles or p95 latency rises by more than 20%:

1. Run \`deploy rollback v2.13.0\`.
2. Post in #incidents with the graph that made you roll back.
3. The release owner writes the follow-up in the thread under the deploy plan.
`,
    },
    bot: { slug: 'coder', name: 'Coder', role: 'Writes and reviews code changes for the Engineering team', trigger: 'mention' },
    fact: {
      topic: 'deploy-freeze',
      title: 'Deploy freeze windows',
      body: 'No production deploys from Friday 16:00 to Monday 09:00 UTC, and none during the last two working days of a quarter. The release manager may grant an exception in #releases.',
    },
    facts2: {
      topic: 'on-call',
      title: 'On-call rotation',
      body: 'The on-call engineer holds role:on-call for one week, handover on Mondays at 10:00 UTC. Pages that are not acknowledged within 10 minutes go to the engineering lead.',
    },
    journal:
      'Consolidated from #releases, #incidents and the Deploy plan thread: v2.14 was planned with a 10% canary for 30 minutes and a rollback to v2.13. The cache TTL change from 300 s to 60 s was agreed by Nadia, Rafi and Omar.',
    dispatch: `flowchart LR
  A[Message in #dev] --> B{Bot mentioned?}
  B -- yes --> C[Coder runs]
  B -- no --> D[Stored in the channel]
  C --> E{Needs approval?}
  E -- yes --> F[Approval card to on-call]
  E -- no --> D
  F --> D
`,
  },
  {
    team: 'Customer support',
    slug: 'customer-support',
    a: 'sameera',
    b: 'sameera',
    reports: 'sameera',
    lead: 'omar',
    runbook: {
      title: 'Escalation runbook',
      v1: `# Escalation runbook

When a customer problem is bigger than the first reply.

## Escalate when

1. The customer cannot sign in at all.
2. Data looks lost or wrong.
3. The same problem has come in from three customers in an hour.

## How

Post in #escalations with the ticket number, what the customer sees and what you already tried.
`,
      v2: `# Escalation runbook

When a customer problem is bigger than the first reply.

## Escalate when

1. The customer cannot sign in at all.
2. Data looks lost or wrong.
3. The same problem has come in from three customers in an hour.
4. The customer names a deadline within the next working day.

## How

Post in #escalations with the ticket number, what the customer sees and what you already tried. Tag \`role:support-agent\` for a second pair of eyes; engineering is paged only for the first three cases.

## After

Tell the customer what happens next and when you will write again. Add the answer to #kb-updates once it is fixed.
`,
    },
    bot: { slug: 'support-responder', name: 'Support responder', role: 'Drafts first replies to customer enquiries from the knowledge base', trigger: 'mention' },
    fact: {
      topic: 'reply-times',
      title: 'First reply times',
      body: 'First reply within 4 working hours for paying customers and 1 working day for free plans. Enterprise customers have a named contact and a 1 hour target.',
    },
    facts2: {
      topic: 'refunds',
      title: 'Refund policy',
      body: 'Refunds up to 30 days after a charge need no approval. Anything older goes to the team lead with the ticket number.',
    },
    journal:
      'Consolidated from #support and #escalations: three sign-in tickets in one hour were escalated to Engineering; the answer went into #kb-updates the same afternoon.',
    dispatch: `flowchart LR
  A[Enquiry arrives] --> B{Known answer?}
  B -- yes --> C[Support responder drafts a reply]
  B -- no --> D[Agent answers]
  C --> E[Agent reviews and sends]
  D --> F{Bigger than a reply?}
  F -- yes --> G[Escalate in #escalations]
  F -- no --> E
`,
  },
  {
    team: 'Marketing',
    slug: 'marketing',
    a: 'tariq',
    b: 'priya',
    reports: 'tariq',
    lead: 'tariq',
    runbook: {
      title: 'Campaign launch runbook',
      v1: `# Campaign launch runbook

The steps every campaign goes through, in order.

## Before launch

1. The brief is approved in #campaigns.
2. Copy is reviewed against the brand guide in #brand.
3. Tracking links are tested.

## Launch

1. Schedule the posts in #social.
2. Send the announcement.
3. Post the links in #campaigns.
`,
      v2: `# Campaign launch runbook

The steps every campaign goes through, in order.

## Before launch

1. The brief is approved in #campaigns.
2. Copy is reviewed against the brand guide in #brand.
3. Tracking links are tested.
4. The signups report has a baseline for the week (\`pages/reports/signups.csv\`).

## Launch

1. Schedule the posts in #social.
2. Send the announcement.
3. Post the links in #campaigns.

## After launch

Check signups and churn on Friday in #analytics and add the week to the report. A campaign that moves signups by less than 5% gets a short retro in the thread.
`,
    },
    bot: { slug: 'content-drafter', name: 'Content drafter', role: 'Drafts posts and briefs in the brand voice', trigger: 'mention' },
    fact: {
      topic: 'brand-voice',
      title: 'Brand voice',
      body: 'Plain, specific and friendly. No exclamation marks in headlines, no superlatives without a number behind them. Product names are written as the product writes them.',
    },
    facts2: {
      topic: 'launch-calendar',
      title: 'Launch calendar rules',
      body: 'No two campaigns in the same week. Announcements go out Tuesday to Thursday, 09:00 to 11:00 in the audience time zone.',
    },
    journal:
      'Consolidated from #campaigns and #analytics: the spring launch brief was approved, signups rose from 410 to 455 in a week and churn fell to 1.1%.',
    dispatch: `flowchart LR
  A[Brief approved] --> B[Content drafter writes a draft]
  B --> C{Brand review}
  C -- changes --> B
  C -- approved --> D[Schedule in #social]
  D --> E[Report signups on Friday]
`,
  },
];

export const REPO_TEAM_SLUGS = VOICES.map((v) => v.slug);

/** The person who owns `bots/` and `TEAM.md` of the team's repo: its lead, or a workspace admin for a team without one. */
export function repoLead(slug: string): SeedAuthor {
  const v = VOICES.find((x) => x.slug === slug);
  if (!v) throw new Error(`seed: no repo content for team "${slug}"`);
  return v.lead;
}

const SIGNUPS_CSV = `week,signups,churn
2026-W36,410,1.2%
2026-W37,455,1.1%
2026-W38,470,1.0%
2026-W39,498,0.9%
`;

/** The Markdown digest and changelog (what the page viewer shows: a table, a task list, a link to another page). */
const digest = (team: string): string => `# Week 37

Sessions held steady week over week; the ticket queue grew slightly. See the **report** and [the changelog](pages/changelog.md).

| Metric | Count |
| --- | --- |
| Sessions | 18.4k |
| Tickets | 312 |

- [x] Publish the digest
- [ ] Review the queue

Sources: \`ga:sessions\`, \`support:tickets\`. Written for ${team}.
`;

const CHANGELOG = `# Changelog

## v2.14.0

- Cache TTL lowered from 300 s to 60 s.
- Canary deploys hold at 10% for 30 minutes before promotion.
- Fixed the thread counter that showed one reply too many.

## v2.13.0

- Search finds words with a typo ("rolback" finds "rollback").
- Guests can read the channels they are added to.
`;

/** A page whose frontmatter makes the viewer show a link card: the document lives in Google, the page only points at it. */
const GOOGLE_NOTES = `---
google:
  kind: doc
  title: Q3 planning notes
  url: https://docs.google.com/document/d/1AbCdEfGh/edit
---

Notes live in Google.
`;

const appHtml = (team: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Release checklist</title>
<style>
  body { font: 14px system-ui, sans-serif; margin: 0; padding: 12px; color: rgb(27 36 48); background: rgb(255 255 255); }
  h1 { font-size: 16px; margin: 0 0 4px; }
  p { margin: 0 0 8px; color: rgb(95 107 122); }
  label { display: block; margin: 6px 0; }
  .done { text-decoration: line-through; color: rgb(95 107 122); }
  #left { margin-top: 10px; font-weight: 600; }
</style>
<script src="__manythreads.js"></script>
</head>
<body>
<h1 id="title">Release checklist</h1>
<p id="who">A checklist for the release owner.</p>
<div id="items"></div>
<div id="left"></div>
<script>
(function () {
  var items = [
    'Tag the release',
    'Update the changelog',
    'Hold the canary at 10% for 30 minutes',
    'Promote to 100%',
    'Announce in #releases'
  ];
  var box = document.getElementById('items');
  function left() {
    var open = box.querySelectorAll('input:not(:checked)').length;
    document.getElementById('left').textContent = open === 0 ? 'All done.' : open + ' left';
  }
  items.forEach(function (text, i) {
    var label = document.createElement('label');
    var input = document.createElement('input');
    input.type = 'checkbox';
    input.id = 'item-' + (i + 1);
    input.addEventListener('change', function () {
      label.className = input.checked ? 'done' : '';
      left();
    });
    label.appendChild(input);
    label.appendChild(document.createTextNode(' ' + text));
    box.appendChild(label);
  });
  left();
  // The bridge answers with this folder and the team name, nothing else (no session, no other files).
  window.manythreads.getContext().then(function (ctx) {
    document.getElementById('who').textContent = 'A checklist for the release owner of ' + ctx.team + ' (' + ctx.app + ').';
  }, function () {
    document.getElementById('who').textContent = 'A checklist for the release owner of ${team}.';
  });
})();
</script>
</body>
</html>
`;

const botMd = (v: TeamVoice): string => `---
schema: 1
name: ${v.bot.name}
role: ${v.bot.role}
kind: agent
runtime: hermes
model:
  aliases: [default]
triggers:
  - type: ${v.bot.trigger}
  - type: conversation
memory:
  file: memory.md
  maxLines: 200
---

# ${v.bot.name}

Placeholder definition for the ${v.team} team. ${v.bot.role}.

## Behaviour

Answer in the channel where you were asked. Say what you did and link what you changed. Ask before anything that cannot be undone.
`;

const botMemory = (v: TeamVoice): string => `# ${v.bot.name}: memory

Nothing learned yet. Facts worth keeping go to \`memory/facts/\`; this file holds what only this bot needs.
`;

const botLessons = (v: TeamVoice): string => `# ${v.bot.name}: lessons

Corrections from the team are collected here by the Workshop. None yet.
`;

const factMd = (f: { title: string; body: string }): string => `# ${f.title}

${f.body}
`;

/**
 * The commits of a team's seed history, oldest first. Every step is one commit with its own message; the runbook is committed twice
 * by two people so the History panel has a diff to show. `adoptTeamMd` is handled by the seeder (it needs the current file).
 */
export function repoSteps(slug: string): RepoStep[] {
  const v = VOICES.find((x) => x.slug === slug);
  if (!v) throw new Error(`seed: no repo content for team "${slug}"`);
  return [
    { actor: v.a, message: `Add the ${v.runbook.title.toLowerCase()}`, files: [{ path: 'pages/runbook.md', content: v.runbook.v1 }] },
    {
      actor: v.b,
      message: `Runbook: ${v.slug === 'engineering' ? 'add the canary hold and the rollback' : v.slug === 'marketing' ? 'add the baseline and the after-launch check' : 'add the deadline case and what to tell the customer'}`,
      files: [{ path: 'pages/runbook.md', content: v.runbook.v2 }],
      ...(v.a !== v.b ? { coAuthors: [v.a] } : {}),
    },
    { actor: v.reports, message: 'Add the weekly signups report', files: [{ path: 'pages/reports/signups.csv', content: SIGNUPS_CSV }] },
    {
      actor: v.b,
      message: 'Add the weekly digest and the changelog',
      files: [
        { path: 'pages/weekly-digest.md', content: digest(v.team) },
        { path: 'pages/changelog.md', content: CHANGELOG },
      ],
    },
    {
      actor: v.a,
      message: 'Add the dispatch diagram and the Q3 planning link',
      files: [
        { path: 'pages/diagrams/dispatch.mmd', content: v.dispatch },
        { path: 'pages/q3-planning-notes.md', content: GOOGLE_NOTES },
      ],
    },
    { actor: v.b, message: 'Add the release checklist app', files: [{ path: 'apps/release-checklist/index.html', content: appHtml(v.team) }] },
    {
      actor: v.lead,
      message: `Add the ${v.bot.name} bot placeholder`,
      files: [
        { path: `bots/${v.bot.slug}/BOT.md`, content: botMd(v) },
        { path: `bots/${v.bot.slug}/memory.md`, content: botMemory(v) },
        { path: `bots/${v.bot.slug}/lessons.md`, content: botLessons(v) },
      ],
    },
    {
      actor: v.lead,
      message: 'Record the first team facts',
      files: [
        { path: `memory/facts/${v.fact.topic}.md`, content: factMd(v.fact) },
        { path: `memory/facts/${v.facts2.topic}.md`, content: factMd(v.facts2) },
      ],
    },
    {
      actor: 'system',
      message: 'Consolidate 2026-03-06',
      files: [{ path: 'memory/journal/2026-03-06.md', content: `# 2026-03-06\n\n${v.journal}\n` }],
    },
  ];
}
