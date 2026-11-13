import type { CredentialIdentity, CredentialTeam, ProjectCredentialsProvider } from '@manythreads/sdk';
import { ProjectBranch, ProjectName, isPlainRepoUrl } from '@manythreads/shared';
import type { K8s, K8sObject } from './k8s.ts';
import { resolvePodNames } from './reconcile.ts';
import { labelsFor, type PodConfig } from './render.ts';

/**
 * The `project.credentials` provider: the projects' GitHub tokens, in one Secret of the team's pod namespace (`hermes-<team>-push`, one key per
 * project name). The workbench container mounts it root-only and hands each file to the `repo` Unix user alone, so a bot cannot read a token and
 * neither can the database or an event: nothing here is ever logged, and the errors that leave this file name the Kubernetes call, never the value.
 *
 * A key is a project's name, or `_owner.<host>.<owner>` for a token the team keeps once for every project under one GitHub owner (a project name cannot
 * start with an underscore, so the two never collide). A project's own document then holds no token, only `via` (the owner key) beside the address and branch.
 * Each project's own document also says which provider the token is for and who commits: `provider` (`github` or `gitlab`), the bot account's `login` and
 * numeric `userId`, and `commitAs` (`bot`: the bot is the author of a published commit too; `requester`: the person who asked is). The owner-token document holds only the token. A document written before these
 * fields existed has none of them: it counts as GitHub with no identity. A document GitHub has turned down carries `refused: true` on the document that holds the token (`setRefused`); the pod's publish command and the server's pull-request
 * sync stop using it, and saving a new token writes a fresh document without the mark.
 *
 * Changes to one team's Secret run one at a time IN THIS PROCESS (a promise chain: the server runs as a single replica, as the blob volume requires; two
 * replicas would need a lock in the cluster, e.g. a resourceVersion-checked update) (read, change one key, write back), so two people setting tokens for two projects of the same
 * team cannot overwrite each other. The Secret is written with `data` (not `stringData`) so server-side apply owns each key and drops one that is left out.
 */
const OWNER_KEY = /^[a-z0-9][a-z0-9.-]{0,200}\/[a-z0-9][a-z0-9-]{0,38}$/;
/** The Secret key of an owner token: `github.com/acme` becomes `_owner.github.com.acme` (an owner has no dot in its name, so the last part is the owner). */
const ownerSecretKey = (ownerKey: string): string => `_owner.${ownerKey.replace('/', '.')}`;
const isOwnerSecretKey = (k: string): boolean => k.startsWith('_owner.');

const PROVIDERS: ReadonlySet<string> = new Set(['github', 'gitlab']);
const COMMIT_AS: ReadonlySet<string> = new Set(['bot', 'requester']);
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const USER_ID = /^[0-9]{1,20}$/;
/** Why an identity is not acceptable, or null. The messages name the field, never a value. */
function identityProblem(identity: CredentialIdentity | undefined): string | null {
  if (identity === undefined) return null;
  if (typeof identity.provider !== 'string' || !PROVIDERS.has(identity.provider)) return 'bad provider';
  if (typeof identity.login !== 'string' || !LOGIN.test(identity.login)) return 'bad login';
  if (typeof identity.userId !== 'string' || !USER_ID.test(identity.userId)) return 'bad user id';
  if (typeof identity.commitAs !== 'string' || !COMMIT_AS.has(identity.commitAs)) return 'bad commit as';
  return null;
}
const identityFields = (identity: CredentialIdentity | undefined): Record<string, string> =>
  identity === undefined ? {} : { commitAs: identity.commitAs, login: identity.login, provider: identity.provider, userId: identity.userId };
/** The identity a document carries, or undefined when any part is missing or not valid (a document from before the fields existed). */
function identityOf(doc: Doc): CredentialIdentity | undefined {
  const identity = { provider: doc.provider, login: doc.login, userId: doc.userId, commitAs: doc.commitAs } as CredentialIdentity;
  return identityProblem(identity) === null ? identity : undefined;
}

interface Doc {
  provider?: unknown;
  login?: unknown;
  userId?: unknown;
  commitAs?: unknown;
  token?: unknown;
  origin?: unknown;
  branch?: unknown;
  via?: unknown;
  setAt?: unknown;
  refused?: unknown;
}
const parseDoc = (v: string | undefined): Doc | null => {
  if (v === undefined) return null;
  try {
    const doc = JSON.parse(Buffer.from(v, 'base64').toString('utf8')) as unknown;
    return doc !== null && typeof doc === 'object' ? (doc as Doc) : null;
  } catch {
    return null;
  }
};
const encode = (doc: Record<string, unknown>): string => Buffer.from(JSON.stringify(doc), 'utf8').toString('base64');

/** Remove owner tokens that no project document points at. */
function dropUnreferencedOwners(data: Record<string, string>): void {
  const used = new Set<string>();
  for (const [k, v] of Object.entries(data)) if (!isOwnerSecretKey(k)) used.add(String(parseDoc(v)?.via ?? ''));
  for (const k of Object.keys(data)) if (isOwnerSecretKey(k) && !used.has(k)) delete data[k];
}

export class PushCredentials implements ProjectCredentialsProvider {
  readonly id = 'project.credentials' as const;
  [member: string]: unknown;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly k8s: () => K8s,
    private readonly cfg: Pick<PodConfig, 'namespace'>,
  ) {}

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async load(team: CredentialTeam): Promise<{ name: string; data: Record<string, string> }> {
    const k8s = this.k8s();
    const names = await resolvePodNames(k8s, this.cfg, team);
    const existing = await k8s.get('Secret', this.cfg.namespace, names.push);
    return { name: names.push, data: { ...((existing?.data as Record<string, string> | undefined) ?? {}) } };
  }

  private secret(team: CredentialTeam, name: string, data: Record<string, string>): K8sObject {
    return { apiVersion: 'v1', kind: 'Secret', metadata: { name, namespace: this.cfg.namespace, labels: labelsFor(team) }, type: 'Opaque', data };
  }

  put(team: CredentialTeam, projectName: string, token: string, origin: string, branch: string, identity?: CredentialIdentity): Promise<void> {
    if (!ProjectName.safeParse(projectName).success) return Promise.reject(new Error('bad project name'));
    const problem = identityProblem(identity);
    if (problem !== null) return Promise.reject(new Error(problem));
    if (token === '' || !/^[\x21-\x7e]+$/.test(token)) return Promise.reject(new Error('bad token'));
    if (!isPlainRepoUrl(origin)) return Promise.reject(new Error('bad origin'));
    if (!ProjectBranch.safeParse(branch).success) return Promise.reject(new Error('bad branch'));
    return this.serialized(async () => {
      const { name, data } = await this.load(team);
      // one JSON document per project: what mt-publish.sh reads with jq (the token for git and curl, the address it must match)
      data[projectName] = encode({ ...identityFields(identity), branch, origin, setAt: new Date().toISOString(), token });
      dropUnreferencedOwners(data); // the project may have been on an owner token before
      await this.k8s().apply(this.secret(team, name, data));
    });
  }

  putShared(team: CredentialTeam, ownerKey: string, token: string, projects: ReadonlyArray<{ name: string; origin: string; branch: string }>, drop: ReadonlyArray<string> = [], identity?: CredentialIdentity): Promise<void> {
    if (!OWNER_KEY.test(ownerKey)) return Promise.reject(new Error('bad owner'));
    const problem = identityProblem(identity);
    if (problem !== null) return Promise.reject(new Error(problem));
    if (token === '' || !/^[\x21-\x7e]+$/.test(token)) return Promise.reject(new Error('bad token'));
    if (projects.length === 0) return Promise.reject(new Error('no projects'));
    for (const p of projects) {
      if (!ProjectName.safeParse(p.name).success) return Promise.reject(new Error('bad project name'));
      if (!isPlainRepoUrl(p.origin)) return Promise.reject(new Error('bad origin'));
      if (!ProjectBranch.safeParse(p.branch).success) return Promise.reject(new Error('bad branch'));
    }
    for (const d of drop) if (!ProjectName.safeParse(d).success) return Promise.reject(new Error('bad project name'));
    return this.serialized(async () => {
      const { name, data } = await this.load(team);
      const now = new Date().toISOString();
      const via = ownerSecretKey(ownerKey);
      for (const d of drop) delete data[d]; // in the same change, so a failure leaves the Secret exactly as it was
      data[via] = encode({ setAt: now, token });
      for (const p of projects) data[p.name] = encode({ ...identityFields(identity), branch: p.branch, origin: p.origin, setAt: now, via });
      dropUnreferencedOwners(data);
      await this.k8s().apply(this.secret(team, name, data));
    });
  }

  setRefused(team: CredentialTeam, projectName: string, refused: boolean): Promise<void> {
    return this.serialized(async () => {
      const { name, data } = await this.load(team);
      const own = parseDoc(data[projectName]);
      if (!own) return;
      const holder = typeof own.via === 'string' && own.via in data ? own.via : projectName;
      const doc = parseDoc(data[holder]);
      if (!doc || (doc.refused === true) === refused) return;
      const next: Record<string, unknown> = { ...doc };
      if (refused) next['refused'] = true;
      else delete next['refused'];
      data[holder] = encode(next);
      await this.k8s().apply(this.secret(team, name, data));
    });
  }

  setCommitAs(team: CredentialTeam, projectName: string, commitAs: 'bot' | 'requester'): Promise<void> {
    if (!COMMIT_AS.has(commitAs)) return Promise.reject(new Error('bad commit as'));
    return this.serialized(async () => {
      const { name, data } = await this.load(team);
      const own = parseDoc(data[projectName]);
      if (!own || own.commitAs === commitAs) return;
      data[projectName] = encode({ ...own, commitAs });
      await this.k8s().apply(this.secret(team, name, data));
    });
  }

  remove(team: CredentialTeam, projectName: string): Promise<void> {
    return this.serialized(async () => {
      const { name, data } = await this.load(team);
      if (!(projectName in data)) return;
      delete data[projectName];
      dropUnreferencedOwners(data); // the last project on an owner token takes the token with it
      if (Object.keys(data).length === 0) await this.k8s().delete('Secret', this.cfg.namespace, name);
      else await this.k8s().apply(this.secret(team, name, data));
    });
  }

  /**
   * Remove the tokens of projects that are not in `keep` (the projects whose row says a token is set) and that are older than `graceMs`. A token whose row
   * never got the flag (the request that wrote the Secret failed to commit) is cleaned up here, and the grace period keeps a token that is being set
   * right now (its row is not committed yet) from being taken away. Returns the names removed.
   */
  prune(team: CredentialTeam, keep: ReadonlySet<string>, graceMs = 120_000, now = Date.now()): Promise<string[]> {
    return this.serialized(async () => {
      const { name, data } = await this.load(team);
      const gone: string[] = [];
      for (const [project, v] of Object.entries(data)) {
        if (isOwnerSecretKey(project) || keep.has(project)) continue;
        let setAt = 0;
        try {
          setAt = Date.parse(String(parseDoc(v)?.setAt ?? ''));
        } catch {
          /* an unreadable entry counts as old */
        }
        if (Number.isFinite(setAt) && now - setAt < graceMs) continue;
        delete data[project];
        gone.push(project);
      }
      const before = Object.keys(data).length;
      dropUnreferencedOwners(data);
      if (gone.length === 0 && Object.keys(data).length === before) return gone;
      if (Object.keys(data).length === 0) await this.k8s().delete('Secret', this.cfg.namespace, name);
      else await this.k8s().apply(this.secret(team, name, data));
      return gone;
    });
  }

  async read(team: CredentialTeam, projectName: string): Promise<{ token: string; origin: string; branch: string; refused?: boolean; identity?: CredentialIdentity } | null> {
    const { data } = await this.load(team);
    const doc = parseDoc(data[projectName]);
    if (!doc || typeof doc.origin !== 'string' || typeof doc.branch !== 'string') return null;
    // a project on an owner token holds the address and branch itself; the token (and the refused mark) are the owner's
    const holder = typeof doc.via === 'string' ? (isOwnerSecretKey(doc.via) ? parseDoc(data[doc.via]) : null) : doc;
    if (!holder || typeof holder.token !== 'string') return null;
    const identity = identityOf(doc);
    return { token: holder.token, origin: doc.origin, branch: doc.branch, ...(holder.refused === true ? { refused: true } : {}), ...(identity ? { identity } : {}) };
  }
}
