import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { GIT_TOOLS, PUBLISH_TOOL, RECORD_TOOLS, whereYouRun } from '@manythreads/shared';
import { parseServerProfileName, type BridgeConfig, type ProfileConfig } from './config.ts';
import type { RunRequest } from './request.ts';

// What a bot's run needs on an enrolled server, made per run (PLAN P26-15, docs/plans/agents-anywhere.md section 5.6). A pod gets all of this from its controller; a server has no controller,
// so the bridge asks the site, with the run's own token, the same three questions the pod's containers ask:
//   GET /api/runs/self                     may this bot publish? (its definition grants tasks.pull_request)
//   GET /api/runs/self/kubeconfig          the team's deployer login, answered only to the team's deployer bot (404 for any other)
//   GET /api/llm/runs/<runId>/v1/models    Hermes only: the models the bot's key may call, to pick the one Hermes answers with
// and builds a copy of the bot's profile for this one run: the "Where you run" text (the same function the pod renderer calls), the commands Claude may run without a question, the folder
// of `mt-git` and `mt-publish` on the PATH, the publisher's socket, the kubeconfig of this bot only, and, for Hermes, the home that points its model at the site's run proxy with the
// run's own token (so its spend is on the workspace ledger and the server holds no model key). The token is never written to a file here: it reaches the program through its environment.

export interface ServerRunSupport {
  /** The site's address (https://<site>), where the three routes above are. */
  siteUrl: string;
  fetch?: typeof fetch;
  log: (line: string) => void;
}

const TIMEOUT_MS = 15_000;
/** The name of the variable a Hermes home refers to for the run proxy's address and the model; the file written once names them, the values change with every run. */
export const HERMES_URL_VAR = 'MANYTHREADS_LLM_URL';
export const HERMES_MODEL_VAR = 'MANYTHREADS_LLM_MODEL';
const TOKEN_VAR = 'MANYTHREADS_RUN_TOKEN';

/**
 * The Hermes home's config for a server: one custom provider whose address, key and model are read from the environment at every start. The file is the same for every run, so two runs of
 * one bot at once never write each other's address, and it holds no secret.
 */
export const HERMES_SEED = [
  '# Written by the manythreads bridge. Do not edit: it is written again when it differs.',
  '# The model is reached through the site (the run proxy) with the run\'s own token, which the bridge puts in the environment of each run.',
  'model:',
  '  provider: "manythreads"',
  `  default: "\${${HERMES_MODEL_VAR}}"`,
  'providers:',
  '  manythreads:',
  '    name: "manythreads"',
  `    api: "\${${HERMES_URL_VAR}}"`,
  `    api_key: "\${${TOKEN_VAR}}"`,
  '    transport: "chat_completions"',
  `    default_model: "\${${HERMES_MODEL_VAR}}"`,
  '',
].join('\n');

/** The kubeconfig of one bot's profile on this machine: a private folder of its own, mode 0600, written again at every run that is answered with one. */
export const kubeconfigFile = (root: string, team: string, bot: string): string => join(root, 'kube', `${team}--${bot}`, 'config');

async function ask(url: string, token: string, doFetch: typeof fetch): Promise<{ status: number; json: unknown }> {
  const res = await doFetch(url, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
  let json: unknown = null;
  if (res.ok) json = await res.json().catch(() => null);
  else await res.body?.cancel().catch(() => undefined);
  return { status: res.status, json };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Writes a file in one step with the given mode (a private temporary file, then a rename). */
function writePrivate(file: string, text: string, mode: number): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.new`;
  writeFileSync(tmp, text, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, file);
}

/** The model the run should use: the alias the bot's definition named when the key may call it, else the first the key may call, else the alias (or `smart`). */
async function pickModel(site: string, runId: string, token: string, alias: string | null, doFetch: typeof fetch, log: (l: string) => void): Promise<string> {
  try {
    const { status, json } = await ask(`${site}/api/llm/runs/${encodeURIComponent(runId)}/v1/models`, token, doFetch);
    if (status === 200 && isRecord(json) && Array.isArray(json['data'])) {
      const ids = json['data'].flatMap((m) => (isRecord(m) && typeof m['id'] === 'string' ? [m['id']] : []));
      if (alias !== null && ids.includes(alias)) return alias;
      if (ids[0] !== undefined) return ids[0];
    } else log(`server run: the model list answered ${status}`);
  } catch {
    log('server run: the model list could not be read');
  }
  return alias ?? 'smart';
}

/**
 * The profile this run uses on an enrolled server. A name that is not a server-mode name, or a bridge without a `server` section, gets the profile back unchanged. Every question to the site
 * that fails is answered with "no" (cannot publish, no kubeconfig): a run never waits on a failure here, and never fails because of one.
 */
export async function prepareServerRun(config: BridgeConfig, name: string, profile: ProfileConfig, request: RunRequest, support: ServerRunSupport): Promise<ProfileConfig> {
  const server = config.server;
  const who = server === undefined ? null : parseServerProfileName(name);
  if (server === undefined || who === null) return profile;
  const doFetch = support.fetch ?? fetch;
  const site = support.siteUrl.replace(/\/+$/, '');
  const token = request.manythreads.mcp?.token ?? null;
  const publisherOn = server.publisherSocket !== undefined;

  let mayPublish = false;
  let kubeconfig: string | null = null;
  const file = kubeconfigFile(server.root, who.team, who.bot);
  if (token !== null) {
    try {
      const self = await ask(`${site}/api/runs/self`, token, doFetch);
      mayPublish = publisherOn && self.status === 200 && isRecord(self.json) && self.json['mayPublish'] === true;
    } catch {
      support.log('server run: could not ask the site whether this bot may publish');
    }
    try {
      const kube = await ask(`${site}/api/runs/self/kubeconfig`, token, doFetch);
      if (kube.status === 200 && isRecord(kube.json) && typeof kube.json['kubeconfig'] === 'string' && kube.json['kubeconfig'] !== '') {
        writePrivate(file, kube.json['kubeconfig'], 0o600);
        kubeconfig = file;
      } else if (kube.status === 404) {
        // not the team's deployer (any more): a login written for an earlier run is removed
        rmSync(file, { force: true });
      }
    } catch {
      support.log('server run: could not ask the site for a kubeconfig');
    }
  }

  const where = whereYouRun({
    place: 'server',
    agent: who.agentKey,
    teamSlug: who.team,
    botSlug: who.bot,
    mayPublish,
    kubeconfig,
    browser: (server.agents[who.agentKey]?.env?.['PLAYWRIGHT_BROWSERS_PATH'] ?? '') !== '',
    serverRoot: server.root,
  });
  const instructions = [where, profile.instructions].filter((t): t is string => t !== undefined && t.trim() !== '').join('\n\n');

  const env: Record<string, string> = { ...(profile.env ?? {}) };
  if (server.toolsDir !== undefined) env['PATH'] = `${server.toolsDir}:${process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin'}`;
  // `mt-publish` presents the run's own token to the publisher, which asks the site with it. The ACP adapters are started without the token in their environment (the platform's tools get it in the
  // session's MCP header), so a bot that may publish is the one run that gets it here: the token opens this run only and the answer is scrubbed of it like every other text.
  if (mayPublish && server.publisherSocket !== undefined && token !== null) {
    env['MT_PUBLISH_SOCKET'] = server.publisherSocket;
    env[TOKEN_VAR] = token;
  }
  if (kubeconfig !== null) env['KUBECONFIG'] = kubeconfig;

  if (who.agentKey === 'hermes') {
    // Hermes' own home, one per bot, under the bridge's data folder: never the bridge user's default and never anyone's login. Its config is written once; the run's values come through the environment.
    const home = env['HERMES_HOME'] ?? join(server.root, 'hermes', `${who.team}--${who.bot}`);
    env['HERMES_HOME'] = home;
    const configFile = join(home, 'config.yaml');
    let have = '';
    try {
      have = readFileSync(configFile, 'utf8');
    } catch {
      // first run of this bot
    }
    if (have !== HERMES_SEED) writePrivate(configFile, HERMES_SEED, 0o600);
    if (token !== null && request.manythreads.runId !== null) {
      env[TOKEN_VAR] = token;
      env[HERMES_URL_VAR] = `${site}/api/llm/runs/${encodeURIComponent(request.manythreads.runId)}/v1`;
      env[HERMES_MODEL_VAR] = await pickModel(site, request.manythreads.runId, token, request.manythreads.model.alias, doFetch, support.log);
    }
  }

  const extraAllowedTools =
    who.agentKey === 'claude' ? [...new Set([...GIT_TOOLS, ...RECORD_TOOLS, ...(mayPublish ? [PUBLISH_TOOL] : []), ...(profile.extraAllowedTools ?? [])])] : profile.extraAllowedTools;
  return { ...profile, env, instructions, ...(extraAllowedTools !== undefined ? { extraAllowedTools } : {}) };
}
