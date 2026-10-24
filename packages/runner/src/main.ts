#!/usr/bin/env -S npx tsx
import { homedir } from 'node:os';
import { startRunnerClient, RUNNER_VERSION } from './client.ts';
import { detectCapabilities, realProbe } from './capabilities.ts';
import { ConfigError, loadConfig, profilesDir, readToken } from './config.ts';
import { sweepStaleProfiles } from '@manythreads/sdk/process';

const USAGE = `manythreads-runner ${RUNNER_VERSION}: runs a team's agents on this machine.

  --server <url>           the server's public address, e.g. https://threads.example            (MANYTHREADS_RUNNER_SERVER)
  --token-file <path>      a file holding the runner token (chmod 600)                           (MANYTHREADS_RUNNER_TOKEN_FILE)
  --name <name>            check the token belongs to this runner (optional)                      (MANYTHREADS_RUNNER_NAME)
  --hermes-bin <path>      the Hermes program (default: hermes)                                   (MANYTHREADS_HERMES_BIN)
  --hermes-home <dir>      Hermes' home; profiles go in <dir>/profiles (default: ~/.hermes)       (HERMES_HOME)
  --workspace-root <dir>   one persistent workspace per team: <dir>/<team>/ (default: ~/manythreads-workspaces)
  --max-jobs <n>           jobs at once (default: 2)                                              (MANYTHREADS_RUNNER_MAX_JOBS)
  --terminal docker|local  where the agent's shell commands run (default: docker)                 (MANYTHREADS_RUNNER_TERMINAL)
  --sandbox-image <image>  the image for docker (default: manythreads/runner-sandbox:1)           (MANYTHREADS_RUNNER_SANDBOX_IMAGE)
  --capabilities a,b       extra capabilities to advertise                                        (MANYTHREADS_RUNNER_CAPABILITIES)
`;

const log = (line: string): void => console.log(`${new Date().toISOString()} runner: ${line}`);

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  const config = loadConfig(argv, process.env);
  const token = readToken(config.tokenFile);
  // A dead runner can leave profiles (they hold a run token and the bot's tokens): anything of ours older than the longest run goes.
  const swept = await sweepStaleProfiles(profilesDir(config), 2 * 60 * 60 * 1000);
  if (swept > 0) log(`removed ${swept} profile(s) a previous run left behind`);

  const probe = realProbe(process.env, homedir());
  const capabilities = (): Promise<string[]> => detectCapabilities(probe, config.hermesBin, config.extraCapabilities);
  const advertised = await capabilities();
  if (!advertised.includes('hermes')) log(`warning: no Hermes program at "${config.hermesBin}"; jobs will fail until it is installed`);
  if (config.terminal === 'docker' && !advertised.includes('docker')) log('warning: the docker daemon is not reachable; the agent\'s shell commands will fail');
  log(`starting ${RUNNER_VERSION} for ${config.server}; capabilities: ${advertised.join(' ') || '(none)'}; workspaces in ${config.workspaceRoot}`);

  const client = startRunnerClient({ config, token, capabilities, log });
  const shutdown = (signal: string): void => {
    log(`${signal}: stopping running jobs and disconnecting`);
    void client.stop().then(() => process.exit(0));
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  await client.done;
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    if (err instanceof ConfigError) {
      console.error(`manythreads-runner: ${err.message}\n\nrun with --help for the options`);
      process.exit(78);
    }
    console.error(err);
    process.exit(1);
  },
);
