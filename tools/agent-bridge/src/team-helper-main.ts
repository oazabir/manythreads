import { main } from './team-helper.ts';

// The entry the installer's bundle builds as `helper/team-helper.mjs` (install/build.mjs): run through sudo by the bridge's user, as root. Nothing else imports this file.
process.exitCode = await main(process.argv.slice(2));
