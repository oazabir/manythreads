#!/usr/bin/env node
// Bundles the fake ACP agent (src/cli.ts and what it imports, with the ACP library) into ONE file a pod image can run with plain `node`, for deploy/images/claude-pod-fake:
// `node tools/fake-acp-agent/bundle.mjs <out-file>` (default `./fake-acp-agent.mjs`). The image's `claude-agent-acp` and `codex-acp` are two-line wrappers around that file
// (P27-19). esbuild comes with tsx, which this package already uses; nothing is installed for it.
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fromTsx = createRequire(createRequire(import.meta.url).resolve('tsx/package.json', { paths: [here] }));
const esbuild = fromTsx('esbuild');
const out = resolve(process.argv[2] ?? 'fake-acp-agent.mjs');
await esbuild.build({
  entryPoints: [resolve(here, 'src/cli.ts')],
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'error',
});
process.stdout.write(`${out}\n`);
