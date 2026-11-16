// Builds what the site serves at /install/ (PLAN P26-14, docs/plans/agents-anywhere.md §5.2):
//
//   <out>/bridge.sh              the installer, still with @@SITE@@, @@BUNDLE_SHA256@@ and @@BRIDGE_VERSION@@ in it (the site fills them in when it serves it)
//   <out>/bridge-<version>.tgz   bridge.mjs (the bridge as one bundled file), helper/team-helper.mjs (the root helper of the per-team users), agents/package.json + package-lock.json (the pinned agent programs), tools/ (the pod's own
//                                mt-git.mjs, publisher.mjs, repo-sync.sh and the workbench's mt-publish.sh and mt-askpass.sh, unchanged), VERSION
//   <out>/manifest.json          { bridgeVersion, bundle, bundleSha256 }
//
// Run: node tools/agent-bridge/install/build.mjs [--out packages/plugins/bot-runners/install-dist]
// The version is the first 12 hex characters of the SHA-256 over the files that go into the bundle, so the same source always gives the same name and a change always
// gives a new one. The tarball is made with fixed ownership, mode and times so the same input gives the same bytes.

import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const bridge = resolve(here, '..');
const argOut = process.argv.indexOf('--out');
const out = resolve(argOut > 0 ? process.argv[argOut + 1] : join(bridge, '..', '..', 'packages', 'plugins', 'bot-runners', 'install-dist'));

// The programs of a pod that a server runs too (P26-15): one copy of each, taken from where the pod image takes them.
const repo = resolve(bridge, '..', '..');
const TOOLS = [
  join(repo, 'deploy', 'images', 'agent-pod', 'mt-git.mjs'),
  join(repo, 'deploy', 'images', 'agent-pod', 'publisher.mjs'),
  join(repo, 'deploy', 'images', 'agent-pod', 'repo-sync.sh'),
  join(repo, 'deploy', 'images', 'workbench', 'mt-publish.sh'),
  join(repo, 'deploy', 'images', 'workbench', 'mt-askpass.sh'),
];

const stage = mkdtempSync(join(tmpdir(), 'bridge-bundle-'));
try {
  // 1. the bridge as one file (ws and the ACP client library inside; Node's own modules stay outside). The version is filled in after the files' hash is known, so the
  //    bundle is built twice only in the sense that the define comes from the first pass over the sources.
  const sources = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));
  const hash = createHash('sha256');
  for (const f of [...sources(join(bridge, 'src')), join(bridge, 'install', 'agents', 'package.json'), join(bridge, 'install', 'agents', 'package-lock.json'), ...TOOLS].sort()) {
    hash.update(f.startsWith(bridge) ? f.slice(bridge.length) : f.slice(repo.length));
    hash.update(readFileSync(f));
  }
  const version = hash.digest('hex').slice(0, 12);
  // `--bridge-only <file>`: only the bridge as one file, for the agent pod image (deploy.sh). The pod used to run the bridge's TypeScript sources with only
  // its npm dependencies beside them, which broke the day the bridge imported a workspace package (@manythreads/shared, 2026-11-16).
  const only = process.argv.indexOf('--bridge-only');
  const bridgeOut = only > 0 ? resolve(process.argv[only + 1]) : join(stage, 'bridge.mjs');
  mkdirSync(join(stage, 'agents'), { recursive: true });
  await build({
    entryPoints: [join(bridge, 'src', 'main.ts')],
    outfile: bridgeOut,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    minify: false,
    legalComments: 'none',
    define: { 'process.env.MANYTHREADS_BRIDGE_VERSION': JSON.stringify(version) },
    // ESM output that bundles CommonJS packages (ws) needs `require`
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    logLevel: 'warning',
  });
  if (only > 0) {
    console.log(`bridge ${version}: ${bridgeOut}`);
    rmSync(stage, { recursive: true, force: true });
    process.exit(0);
  }
  // the root helper of the per-team users (P26-22): its own file, installed by bridge.sh into a folder only root can change; it shares no code with the bridge that it does not check itself
  await build({
    entryPoints: [join(bridge, 'src', 'team-helper-main.ts')],
    outfile: join(stage, 'helper', 'team-helper.mjs'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    minify: false,
    legalComments: 'none',
    logLevel: 'warning',
  });
  copyFileSync(join(bridge, 'install', 'agents', 'package.json'), join(stage, 'agents', 'package.json'));
  copyFileSync(join(bridge, 'install', 'agents', 'package-lock.json'), join(stage, 'agents', 'package-lock.json'));
  mkdirSync(join(stage, 'tools'), { recursive: true });
  for (const f of TOOLS) {
    const to = join(stage, 'tools', basename(f));
    copyFileSync(f, to);
    chmodSync(to, f.endsWith('.sh') ? 0o755 : 0o644);
  }
  writeFileSync(join(stage, 'VERSION'), `${version}\n`);

  // 2. the tarball, reproducible: sorted names, no owner, fixed times, and gzip without a name or time
  mkdirSync(out, { recursive: true });
  const name = `bridge-${version}.tgz`;
  const tar = join(stage, 'bundle.tar');
  execFileSync('tar', ['--sort=name', '--owner=0', '--group=0', '--numeric-owner', '--mtime=2020-01-01 00:00:00Z', '-cf', tar, '-C', stage, 'bridge.mjs', 'helper', 'agents', 'tools', 'VERSION']);
  execFileSync('sh', ['-c', `gzip -9 -n -c "${tar}" > "${join(out, name)}"`]);
  const sha = createHash('sha256').update(readFileSync(join(out, name))).digest('hex');
  copyFileSync(join(here, 'bridge.sh'), join(out, 'bridge.sh'));
  writeFileSync(join(out, 'manifest.json'), `${JSON.stringify({ bridgeVersion: version, bundle: name, bundleSha256: sha }, null, 2)}\n`);
  // older bundles stay for a site that a server updates from a moment later, but only the latest few
  const old = readdirSync(out).filter((f) => /^bridge-[0-9a-f]{12}\.tgz$/.test(f) && f !== name).sort((a, b) => statSync(join(out, b)).mtimeMs - statSync(join(out, a)).mtimeMs);
  for (const f of old.slice(2)) rmSync(join(out, f));
  console.log(`bridge ${version}: ${name} (${Math.round(statSync(join(out, name)).size / 1024)} KB) sha256 ${sha}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
