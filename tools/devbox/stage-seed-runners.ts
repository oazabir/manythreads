import { OMAR } from '../../packages/test-utils/src/personas.ts';
import { seedRunners } from '../../packages/test-utils/src/seed-runners.ts';

/*
 * Seeds the Runners world (seed v19) into the stage release (tools/devbox/stage.sh with STAGE_PROFILE=runners), and removes a runner's sign-in (P19-12). Both go through the real routes of the
 * running server, as Omar, with the dev-actor header the stage's test-mode server honours. The sign-in files are made up (canary strings); nothing here reads a real login.
 *
 *   stage-seed-runners.ts seed                     the six runners and their bots (idempotent). The pod controller of the stage makes the pods; the fake image answers.
 *   stage-seed-runners.ts remove-signin <runner>   "Remove sign-in" on that runner, as the Runners page does it
 *
 * Variables (set by tools/devbox/stage-runners-probe.sh): STAGE_SERVER_URL, STAGE_SYSTEM_DATABASE_URL (seed only).
 */
const need = (name: string): string => {
  const v = (process.env[name] ?? '').trim();
  if (!v) {
    console.error(`stage seed runners: ${name} is not set (run it through tools/devbox/stage-runners-probe.sh)`);
    process.exit(1);
  }
  return v;
};
const url = need('STAGE_SERVER_URL').replace(/\/+$/, '');
const header = { 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: OMAR.actorId, workspaceId: OMAR.workspaceId }) };

const mode = process.argv[2];
if (mode === 'seed') {
  const result = await seedRunners({ url, db: { systemUrl: need('STAGE_SYSTEM_DATABASE_URL') }, timeoutMs: 180_000, log: (line) => console.log(`stage seed runners: ${line}`) });
  console.log(`stage seed runners: done (${Object.keys(result.runners).join(', ')}; ${String(result.bots.length)} bots)`);
  process.exit(0);
}
if (mode === 'remove-signin') {
  const name = process.argv[3];
  if (!name) {
    console.error('usage: stage-seed-runners.ts remove-signin <runner name>');
    process.exit(2);
  }
  const list = await fetch(`${url}/api/admin/bot-runners`, { headers: header });
  const items = ((await list.json()) as { items: Array<{ id: string; name: string }> }).items;
  const runner = items.find((r) => r.name === name);
  if (!runner) {
    console.error(`stage seed runners: no runner named ${name}`);
    process.exit(1);
  }
  const res = await fetch(`${url}/api/admin/bot-runners/${runner.id}/credentials`, { method: 'DELETE', headers: header });
  console.log(`stage seed runners: remove sign-in of ${name}: ${String(res.status)}`);
  process.exit(res.status >= 200 && res.status < 300 ? 0 : 1);
}
console.error('usage: stage-seed-runners.ts seed | remove-signin <runner name>');
process.exit(2);
