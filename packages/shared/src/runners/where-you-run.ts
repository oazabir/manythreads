/*
 * "Where you run" (P26-05, docs/plans/agents-anywhere.md section 5.6): the one block of plain text that tells a bot where it works, whichever place that is. A bot's BOT.md must not
 * care whether it runs in the team's Hermes pod, in an agent pod (Claude or Codex over ACP) or on a server a lead enrolled: the BOT.md says "the team's repository of record" and
 * "`mt-publish`", and this text names the folders and the commands of the place. It is pure text (no clock, no file, no network), so a pod renderer, a server's bridge and the
 * Hermes run prompt call the same function and cannot drift apart.
 */

/** The three places a bot's agent runs. */
export type RunPlace = 'hermes_pod' | 'agent_pod' | 'server';

/** The agent program of a pod or server run; only the notes that agent needs differ. */
export type RunAgent = 'hermes' | 'claude' | 'codex';

/** A kube deploy needs a kaniko build of 10 to 25 minutes (`kubectl wait --timeout=40m`): a deployer's run must be allowed at least this long. */
export const DEPLOYER_MIN_RUN_MINUTES = 45;
export const DEPLOYER_MIN_RUN_SECONDS = DEPLOYER_MIN_RUN_MINUTES * 60;

/** The command every bot that may publish uses, in every place: it asks the place's publisher to push the card branch and open the pull request. The bot never holds the token. */
export const PUBLISH_COMMAND = 'mt-publish';

/**
 * Git commands every bot may run without a question (decision E5, hardened in the P19-09 security review): enough to look, commit on a branch of its own and nothing that
 * reaches the network or rewrites history. They are `mt-git <subcommand>` and never plain `git`: a pre-approved `git diff:*` also allowed `git diff --no-index <any file> /dev/null`
 * (reads the shared sign-in under /state), `git log --output=<path>` (overwrites a file), `git add --pathspec-from-file` (leaks a file in its error text) and, with a hook or
 * a `core.fsmonitor` line written into `.git`, any command. `mt-git` (deploy/images/agent-pod/mt-git.mjs) accepts a fixed list of subcommands and options, keeps to the
 * project folder, refuses a repository config that could start a program and runs git with a clean environment.
 */
export const GIT_WRAPPER = 'mt-git';
export const GIT_TOOLS: readonly string[] = [
  `Bash(${GIT_WRAPPER} status:*)`,
  `Bash(${GIT_WRAPPER} diff:*)`,
  `Bash(${GIT_WRAPPER} log:*)`,
  `Bash(${GIT_WRAPPER} show:*)`,
  `Bash(${GIT_WRAPPER} rev-parse:*)`,
  `Bash(${GIT_WRAPPER} add:*)`,
  `Bash(${GIT_WRAPPER} commit:*)`,
  `Bash(${GIT_WRAPPER} switch:*)`,
  `Bash(${GIT_WRAPPER} checkout -b:*)`,
  `Bash(${GIT_WRAPPER} branch --show-current)`,
  `Bash(${GIT_WRAPPER} fast-forward:*)`,
];
/** The two commands that move a branch between the bots of a pod through the team's repository of record (mt-git.mjs). */
export const RECORD_TOOLS: readonly string[] = [`Bash(${GIT_WRAPPER} record-push:*)`, `Bash(${GIT_WRAPPER} record-fetch)`];
/** The one extra command of a bot whose definition grants `tasks.pull_request`: the client of the pod's publisher. */
export const PUBLISH_TOOL = 'Bash(mt-publish:*)';

/** Where an enrolled server's bridge keeps its folders when the installer made them (the bridge's `server.root`). */
export const SERVER_ROOT = '/var/lib/manythreads-bridge';

/** Where a team's repository of record lies, per place (the same relative place everywhere: `<root>/repos/<project>.git`). */
export const RECORD_ROOTS: Readonly<Record<RunPlace, (teamSlug: string) => string>> = {
  hermes_pod: () => '/workspace/repos',
  agent_pod: (teamSlug) => `/work/${teamSlug}/repos`,
  server: (teamSlug) => `${SERVER_ROOT}/work/${teamSlug}/repos`,
};

/** The team's repository of record for a place; a server whose bridge has another root says so (`serverRoot`). */
const recordRoot = (w: { place: RunPlace; serverRoot?: string | undefined }, team: string): string => (w.place === 'server' && w.serverRoot !== undefined ? `${w.serverRoot}/work/${team}/repos` : RECORD_ROOTS[w.place](team));

const SLUG = /^[a-z0-9][a-z0-9._-]{0,60}$/;
const safe = (value: string, what: string): string => {
  if (!SLUG.test(value) || value.includes('..')) throw new Error(`where-you-run: ${what} "${value.slice(0, 40)}" is not a plain name`);
  return value;
};

export interface WhereYouRun {
  place: RunPlace;
  agent: RunAgent;
  teamSlug: string;
  botSlug: string;
  /** The team's project this run is about, when it has one (the channel's project). */
  project?: string | undefined;
  /** The bot may publish (its definition grants `tasks.pull_request`). */
  mayPublish?: boolean | undefined;
  /** The bot is the team's deployer: a kube context is mounted for it. The path of the kubeconfig, or null when it has none. */
  kubeconfig?: string | null | undefined;
  /** The browser (Chromium with Playwright) is installed in this place. */
  browser?: boolean | undefined;
  /** A server only: the bridge's root folder when it is not the installer's (`/var/lib/manythreads-bridge`). */
  serverRoot?: string | undefined;
  /** The memory the agent and its commands share, in MiB, when the place knows it (an agent pod's limit). */
  memoryMiB?: number | undefined;
}

/** Where a bot's own folder lies. */
export function workFolder(w: Pick<WhereYouRun, 'place' | 'teamSlug' | 'botSlug' | 'serverRoot'>): string {
  const team = safe(w.teamSlug, 'team');
  const bot = safe(w.botSlug, 'bot');
  if (w.place === 'hermes_pod') return `~`;
  if (w.place === 'agent_pod') return `/work/${team}/${bot}`;
  return `${w.serverRoot ?? SERVER_ROOT}/work/${team}/${bot}`;
}

/** The sentence that names a project's repository of record and the bot's clone of it, for one place. */
export function repositoryLine(w: Pick<WhereYouRun, 'place' | 'teamSlug' | 'botSlug' | 'serverRoot'>, project: string): string {
  const p = safe(project, 'project');
  const record = `${recordRoot(w, safe(w.teamSlug, 'team'))}/${p}.git`;
  if (w.place === 'hermes_pod') return `On the team's Hermes pod its repository of record is ${record} and your clone is ~/${p}.`;
  const place = w.place === 'agent_pod' ? "On the team's agent pod" : 'On the server you run on';
  return `${place} its repository of record is ${record} and your clone is ${workFolder(w)}/${p}.`;
}

/**
 * How a branch moves between the bots of a team: plain git on the Hermes pod (a clone's origin there is the repository of record). In an agent pod and on a server a clone's origin is the
 * project's public address and the repository of record is a second, local one, which only `mt-git record-push` and `record-fetch` reach, so those two are named for every agent; Claude has no
 * plain `git` that is not asked about, so it also uses `mt-git` for everything else.
 */
function shareLines(w: WhereYouRun): string[] {
  const card = 'Every card is worked on its own branch, `card-` plus the first eight characters of the card id.';
  if (w.place === 'hermes_pod') {
    return [`${card} Share it with \`git push origin <branch>\` (never \`main\`); read somebody else's with \`git fetch origin\` and \`git switch --detach <commit sha>\`.`];
  }
  const record = `Share it with \`mt-git record-push <branch>\` (never \`main\`) and bring the others' in with \`mt-git record-fetch\`: their branches appear as \`refs/record/<branch>\` (start your own from one with \`mt-git checkout -b <branch> refs/record/<branch>\`; when another bot pushed to the branch you are on, bring yours up to it with \`mt-git record-fetch\` then \`mt-git fast-forward refs/record/<branch>\`, never by editing files under \`.git\`).`;
  if (w.agent === 'claude') {
    return [
      'For git, use `mt-git` in place of `git`: `status`, `diff`, `log`, `show`, `rev-parse`, `add`, `commit -m "<text>"`, `switch`, `checkout -b <branch>`, `branch --show-current` and `fast-forward <commit or refs/record/branch>`, inside the project folder. Plain `git` is not available to you, and `mt-git` refuses any other command or option.',
      'Run each command by itself: go into the project folder with a `cd` of its own (it lasts for your later commands), then one command per call, never joined with `&&`, `;` or `|` (read a file with your Read tool and search with Grep, not `head` or `grep` behind a pipe). A tool result too long to show is saved to a file: read that file with your Read tool, in parts, never with `python3`, `cat` or `jq`. A command joined to another, or one of those, is not on your allowed list and waits for a person to approve it.',
      `${card} ${record}`,
    ];
  }
  return [`${card} Commit with plain \`git\` in the project folder. ${record}`];
}

/** The notes a Codex run needs (P25-16): found by a run of the real chain, not by guessing. */
const CODEX_NOTES: readonly string[] = [
  "The platform's tools (the card, the thread, memory) are not all listed up front: when you need one and do not see it, search for it by name with your tool search before you decide it is missing.",
  'A command that takes a long time (a build, a deploy, a test run) is waited for in the same turn: start it, then poll it until it has ended. Never end your turn to wait for it, because nothing wakes you again.',
  'Do not leave a process running in the background when you finish; a build or a server you started ends with your turn.',
];

/**
 * What a command that runs out of memory looks like, and what to run instead (P31-04): every place stops such a command, not the run, and the bot must not try the same
 * command again or make it bigger.
 */
export function memoryNote(memoryMiB?: number): string {
  const share =
    memoryMiB !== undefined && Number.isInteger(memoryMiB) && memoryMiB > 0
      ? `Your commands and the agent share ${memoryMiB % 1024 === 0 ? `${memoryMiB / 1024} GB` : `${memoryMiB} MB`} of memory. `
      : '';
  return (
    `${share}A command that runs out of memory is stopped (exit code 137, "Killed") and your run goes on: do not run it again as it was. ` +
    'Run focused checks: the typecheck and tests of the package you changed, one test file at a time, `vitest --maxWorkers=1`; never a whole-repository typecheck, lint or test run, ' +
    'and never a bigger `--max-old-space-size` or `NODE_OPTIONS`.'
  );
}

/** What every agent needs, whatever the place: a long command is polled to its end (Hermes shells block, the others must be told). */
const POLL_NOTE = 'A command that takes a long time is waited for in the same turn: poll it until it has ended before you answer.';

/**
 * The whole block, as the lines of the "Where you run" paragraph. Plain sentences, the commands in backticks; no secret, no address of the live site, nothing that
 * differs between two runs of the same bot in the same place.
 */
export function whereYouRun(w: WhereYouRun): string {
  const team = safe(w.teamSlug, 'team');
  const bot = safe(w.botSlug, 'bot');
  const place = w.place === 'hermes_pod' ? "the team's Hermes pod" : w.place === 'agent_pod' ? "the team's agent pod" : 'a server your workspace enrolled';
  const folder = workFolder({ place: w.place, teamSlug: team, botSlug: bot, serverRoot: w.serverRoot });
  const lines: string[] = [
    `You run on ${place}, not on a person's machine. Your working folder is ${folder}; work inside it only.`,
    `The team's repository of record for each project is ${recordRoot(w, team)}/<project>.git: one shared copy per team, which every bot of the team reaches. Your own clone of a project is ${folder}/<project>.`,
  ];
  if (w.project !== undefined) lines.push(repositoryLine({ place: w.place, teamSlug: team, botSlug: bot, serverRoot: w.serverRoot }, w.project));
  lines.push(...shareLines(w));
  lines.push(`Do not read, copy or print anything that holds a sign-in or a key (the runner's state folders, \`${w.place === 'server' ? '/etc/manythreads-bridge' : '/etc/bridge'}\`, the environment): it is not yours to use.`);
  if (w.mayPublish === true) {
    lines.push(
      `To publish a tested card, run \`${PUBLISH_COMMAND} check <project>\` and then \`${PUBLISH_COMMAND} publish <project> <card id> <tested commit> "<title>"\` with the request's text on standard input. The title starts with the task id the card or the request names (for example \`ENG-42: fix the rota\`); when neither names one, it is the card's title. When the card names whose name the commit carries, add the author name and email as the last two arguments, exactly as given.`,
      `\`${PUBLISH_COMMAND}\` makes one commit of the whole change, pushes the card's branch and opens the pull request (merge request on GitLab). You never hold the push token and never push to the main branch yourself.`,
    );
  }
  if (typeof w.kubeconfig === 'string' && w.kubeconfig !== '') {
    lines.push(`You are this team's deployer: \`kubectl\` and \`helm\` already use your kubeconfig (${w.kubeconfig}), which can change the team's test namespace and nothing else. Do not print the file.`);
    lines.push(`A build in the cluster takes 10 to 25 minutes: wait for it in the same turn (\`kubectl wait --timeout=40m\`), and your run may last at least ${DEPLOYER_MIN_RUN_MINUTES} minutes.`);
  }
  if (w.browser === true) lines.push('A browser (Chromium) is installed for Playwright checks; run it headless, there is no display.');
  lines.push(memoryNote(w.memoryMiB));
  lines.push(w.agent === 'codex' ? CODEX_NOTES.join('\n') : POLL_NOTE);
  return lines.join('\n');
}
