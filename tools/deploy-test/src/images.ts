import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The images an install builds or pulls, read from the files that decide it (PLAN P10-09, decision E28): `tools/devbox/deploy.sh` (what it builds), the Dockerfiles it builds from
// (their base images), and the chart's values (what the cluster pulls). `docs/deploy/air-gapped.md` lists the same set; a test compares the two so a new image cannot be added
// without the page learning of it.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

export interface ImageRef {
  /** The reference as the repository spells it: `name:tag` or `name:tag@sha256:...`. For an image the install builds, the name only (`manythreads/server`): its tag is made at build time. */
  ref: string;
  /** Where it comes from. */
  from: 'built' | 'base' | 'chart';
  /** The file that names it. */
  source: string;
}

/** The names `docker build ... -t` makes in deploy.sh, with `$CP_NAME` (the Claude pod image or its stand-in) expanded. */
export function builtImages(script: string): string[] {
  const alternatives = new Map<string, Set<string>>();
  for (const m of script.matchAll(/^\s*(CP_NAME)=(\S+)/gm)) {
    const set = alternatives.get(m[1]!) ?? new Set<string>();
    set.add(m[2]!);
    alternatives.set(m[1]!, set);
  }
  const names = new Set<string>();
  for (const m of script.matchAll(/docker build\b[^\n]*?\s-t\s+"?([^\s"]+)"?(?:\s|$)/g)) {
    const name = m[1]!.replace(/:[^/]*$/, '');
    // The database image is pushed to the in-cluster registry under its own path (`127.0.0.1:30500/$PG_REF`); `installImages` names it from the chart's value.
    if (/^\d+\.\d+\.\d+\.\d+(:|\/)/.test(m[1]!)) continue;
    const variable = /\$\{?([A-Z_]+)\}?/.exec(name)?.[1];
    if (variable !== undefined) {
      for (const value of alternatives.get(variable) ?? []) names.add(name.replace(/\$\{?[A-Z_]+\}?/, value));
    } else names.add(name);
  }
  return [...names].sort();
}

/** The base images of a Dockerfile: its FROM lines that name a real image (not an earlier stage, not another image of ours), with `ARG` defaults filled in. */
export function baseImages(dockerfile: string): string[] {
  const args = new Map<string, string>();
  for (const m of dockerfile.matchAll(/^ARG\s+(\w+)=(\S+)/gm)) args.set(m[1]!, m[2]!);
  const stages = new Set<string>();
  const out = new Set<string>();
  for (const m of dockerfile.matchAll(/^FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/gim)) {
    const image = m[1]!.replace(/\$\{(\w+)\}/g, (_all, name: string) => args.get(name) ?? `\${${name}}`);
    if (m[2] !== undefined) stages.add(m[2].toLowerCase());
    if (stages.has(image.toLowerCase()) && m[2] === undefined) continue;
    if (image.includes('${') || image.startsWith('manythreads/')) continue;
    out.add(image);
  }
  return [...out].sort();
}

/** Every `image:` the chart's values name that is not one of ours (those are built) and not the private registry's. */
export function chartImages(values: string): string[] {
  const out = new Set<string>();
  for (const m of values.matchAll(/^\s*image:\s*([^\s#]+)/gm)) {
    const ref = m[1]!;
    if (ref.startsWith('manythreads/') || ref.startsWith('registry.local:5000/') || ref === '""') continue;
    out.add(ref);
  }
  return [...out].sort();
}

/** The Dockerfiles deploy.sh builds from: every `-f <path>` after `docker build`, and every `docker build ... <dir>` that has a Dockerfile in it. */
export function dockerfilesOf(script: string): string[] {
  const out = new Set<string>();
  for (const m of script.matchAll(/docker build\b[^\n]*/g)) {
    const line = m[0];
    const f = /\s-f\s+"?([^\s"]+)"?/.exec(line)?.[1];
    if (f !== undefined && !f.startsWith('$')) out.add(f);
    else if (f === undefined) {
      const dir = /\s(deploy\/[\w/.-]+)\s*$/.exec(line)?.[1];
      if (dir !== undefined) out.add(`${dir}/Dockerfile`);
    }
  }
  // The pod images built from a folder or a staged copy of one: the Dockerfile sits in deploy/images/<name>.
  for (const m of script.matchAll(/deploy\/images\/([\w-]+)/g)) out.add(`deploy/images/${m[1]}/Dockerfile`);
  return [...out].filter((p) => readdirSync(join(root, dirname(p))).includes(p.split('/').pop()!)).sort();
}

/** Everything the install builds or pulls, as the repository states it. */
export function installImages(): ImageRef[] {
  const deploy = read('tools/devbox/deploy.sh');
  const out: ImageRef[] = [];
  for (const name of builtImages(deploy)) out.push({ ref: name, from: 'built', source: 'tools/devbox/deploy.sh' });
  const seen = new Set<string>();
  for (const file of dockerfilesOf(deploy)) {
    for (const ref of baseImages(read(file))) {
      if (seen.has(ref)) continue;
      seen.add(ref);
      out.push({ ref, from: 'base', source: file });
    }
  }
  const values = read('deploy/helm/manythreads/values.yaml');
  const database = /^\s*image:\s*registry\.local:5000\/(\S+)/m.exec(values)?.[1];
  if (database !== undefined) out.push({ ref: database, from: 'built', source: 'deploy/helm/manythreads/values.yaml (postgres.image, built by tools/devbox/deploy.sh from deploy/postgres/cnpg.Dockerfile)' });
  for (const ref of chartImages(values)) out.push({ ref, from: 'chart', source: 'deploy/helm/manythreads/values.yaml' });
  return out;
}

/** The lines of the fenced block "```text images" of a page: one reference per line, a `#` starts a note. */
export function listedImages(markdown: string): string[] {
  const m = /^```text images\n([\s\S]*?)\n```/m.exec(markdown);
  if (!m) throw new Error('the page has no block tagged "text images"');
  return m[1]!
    .split('\n')
    .map((l) => l.replace(/\s+#.*$/, '').trim())
    .filter((l) => l !== '');
}
