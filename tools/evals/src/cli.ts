import { runEvalCli } from './run.ts';

// Entry of `pnpm test:evals`; the logic lives in run.ts so a test can call it.
const argv = process.argv.slice(2).filter((a) => a !== '--');
const code = await runEvalCli(argv, { out: (l) => console.log(l), err: (l) => console.error(l), cwd: process.cwd() });
process.exit(code);
