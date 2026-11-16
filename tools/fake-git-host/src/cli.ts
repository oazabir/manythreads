import { startFakeGitHost } from './host.ts';

// Runs the fake git host on its own: `FAKE_GIT_TOKEN=<token> tsx src/cli.ts [--owner=<name>] [--repos=a,b]`. Prints one JSON line with the two addresses.
const arg = (name: string): string | undefined => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const token = process.env['FAKE_GIT_TOKEN'];
if (!token) {
  process.stderr.write('FAKE_GIT_TOKEN is not set: the token the host accepts\n');
  process.exit(2);
}
const owner = arg('owner');
const repos = arg('repos')?.split(',').filter(Boolean);
const host = await startFakeGitHost({ token, ...(owner ? { owner } : {}), ...(repos ? { repos } : {}) });
process.stdout.write(`${JSON.stringify({ apiUrl: host.apiUrl, gitUrl: host.gitUrl })}\n`);
const stop = (): void => void host.stop().then(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
