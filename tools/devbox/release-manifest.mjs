#!/usr/bin/env node
// release.json (P27-01): what one release is, in a file small enough to read: the version, every product image by digest, the chart, the SHA-256 of install.sh and of the `manythreads` command (both are release assets beside this file).
// `install.sh` pulls only what this file names (docs/deploy/install.md). Made by tools/devbox/release-images.sh after the push; checked by `check` here and by
// install.sh before it installs anything.
//
//   node tools/devbox/release-manifest.mjs build --version 0.27.0 --owner <owner> --digests <file.json> --install-sha256 <hex> --host-command-sha256 <hex> [--commit <sha>] [--out release.json]
//   node tools/devbox/release-manifest.mjs check release.json

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** The product images of a release: [name, needed]. The package is `ghcr.io/<owner>/manythreads-<name>`. asr is off in the install profile, so a release may leave it out. */
export const RELEASE_IMAGES = [
  ['server', true],
  ['web', true],
  ['postgres-cnpg', true],
  ['hermes-pod', true],
  ['workbench', true],
  ['claude-pod', true],
  ['asr', false],
];

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const OWNER = /^[a-z0-9](?:[a-z0-9-]{0,38})$/;

export const packageName = (owner, name) => `ghcr.io/${owner}/manythreads-${name}`;

/** `ghcr.io/<owner>/manythreads-<name>@sha256:...` for every image of the digests file. Throws a sentence on anything missing or malformed. */
export function buildRelease({ version, owner, digests, installSha256, hostCommandSha256, commit = '', chartVersion = version, now = new Date() }) {
  if (!SEMVER.test(version)) throw new Error(`the version "${version}" is not like 0.27.0`);
  if (!OWNER.test(owner)) throw new Error(`the owner "${owner}" is not a GHCR account name (lower case letters, digits, dashes)`);
  if (!/^[0-9a-f]{64}$/.test(installSha256 ?? '')) throw new Error('the SHA-256 of install.sh is not 64 hex digits');
  if (!/^[0-9a-f]{64}$/.test(hostCommandSha256 ?? '')) throw new Error('the SHA-256 of the manythreads command is not 64 hex digits');
  const images = {};
  for (const [name, needed] of RELEASE_IMAGES) {
    const digest = digests[name];
    if (digest === undefined) {
      if (needed) throw new Error(`the digest of ${name} is missing: push it first`);
      continue;
    }
    if (!DIGEST.test(digest)) throw new Error(`the digest of ${name} is not sha256:<64 hex digits>`);
    images[name] = `${packageName(owner, name)}@${digest}`;
  }
  const unknown = Object.keys(digests).filter((k) => !RELEASE_IMAGES.some(([n]) => n === k));
  if (unknown.length > 0) throw new Error(`not a release image: ${unknown.join(', ')}`);
  return {
    schema: 1,
    version,
    commit,
    createdAt: now.toISOString(),
    registry: `ghcr.io/${owner}`,
    images,
    chart: { ref: `oci://ghcr.io/${owner}/charts/manythreads`, version: chartVersion },
    installSha256,
    hostCommandSha256,
  };
}

/** The problems of a parsed release.json, as sentences; empty when it is good. */
export function checkRelease(release) {
  const problems = [];
  if (release === null || typeof release !== 'object') return ['release.json is not an object'];
  if (release.schema !== 1) problems.push('schema is not 1');
  if (!SEMVER.test(release.version ?? '')) problems.push('version is not like 0.27.0');
  if (!/^[0-9a-f]{64}$/.test(release.installSha256 ?? '')) problems.push('installSha256 is not 64 hex digits');
  if (!/^[0-9a-f]{64}$/.test(release.hostCommandSha256 ?? '')) problems.push('hostCommandSha256 is not 64 hex digits');
  const images = release.images ?? {};
  for (const [name, needed] of RELEASE_IMAGES) {
    const ref = images[name];
    if (ref === undefined) {
      if (needed) problems.push(`image ${name} is missing`);
      continue;
    }
    if (!new RegExp(`^ghcr\\.io/[a-z0-9-]+/manythreads-${name}@sha256:[0-9a-f]{64}$`).test(ref)) problems.push(`image ${name} is not ghcr.io/<owner>/manythreads-${name}@sha256:<digest>`);
  }
  for (const name of Object.keys(images)) if (!RELEASE_IMAGES.some(([n]) => n === name)) problems.push(`image ${name} is not a release image`);
  if (!/^oci:\/\/ghcr\.io\/[a-z0-9-]+\/charts\/manythreads$/.test(release.chart?.ref ?? '')) problems.push('chart.ref is not oci://ghcr.io/<owner>/charts/manythreads');
  if (!SEMVER.test(release.chart?.version ?? '')) problems.push('chart.version is not like 0.27.0');
  return problems;
}

function arg(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function main(argv, out = (l) => process.stdout.write(`${l}\n`), err = (l) => process.stderr.write(`${l}\n`)) {
  const [command, ...rest] = argv;
  try {
    if (command === 'build') {
      const release = buildRelease({
        version: arg(rest, 'version') ?? '',
        owner: arg(rest, 'owner') ?? '',
        digests: JSON.parse(readFileSync(arg(rest, 'digests') ?? '/dev/null', 'utf8')),
        installSha256: arg(rest, 'install-sha256') ?? '',
        hostCommandSha256: arg(rest, 'host-command-sha256') ?? '',
        commit: arg(rest, 'commit') ?? '',
        chartVersion: arg(rest, 'chart-version') ?? arg(rest, 'version') ?? '',
      });
      const text = `${JSON.stringify(release, null, 2)}\n`;
      const file = arg(rest, 'out');
      if (file) writeFileSync(file, text);
      else out(text.trimEnd());
      return 0;
    }
    if (command === 'check') {
      const problems = checkRelease(JSON.parse(readFileSync(rest[0] ?? '/dev/null', 'utf8')));
      for (const p of problems) err(p);
      return problems.length === 0 ? 0 : 1;
    }
    err('usage: release-manifest.mjs build --version V --owner O --digests FILE --install-sha256 HEX --host-command-sha256 HEX [--commit SHA] [--chart-version V] [--out FILE] | check FILE');
    return 2;
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
