import type { ProviderImpl } from './types.ts';

// The `project.credentials` provider (registered by `hermes-pods`): where the GitHub token that lets a team's pod publish a project's tested
// branch lives. Look it up when a request arrives, not in `register`: `ctx.providers.get<ProjectCredentialsProvider>('project.credentials')`.
//
// The token is kept in one Kubernetes Secret of the team's pod namespace and nowhere else: not in the database (which only records that a token is
// set, and when), not in an event, not in a log line. Inside the pod only the `repo` Unix user can read it, so a bot never sees it.

/** The team a credential belongs to: its id and slug (the pod's names are made from the slug). */
export interface CredentialTeam {
  id: string;
  slug: string;
}

/**
 * Whose token it is and where it was issued, kept with the token so the pod's publish command can sign a commit as the bot and call the right API without
 * asking anyone. `provider` is `github` or `gitlab`; `login` is the bot account's login and `userId` its numeric id on that provider (as a string), used for
 * the account's no-reply address. Not secret, but only ever stored beside the token.
 */
export interface CredentialIdentity {
  provider: 'github' | 'gitlab';
  login: string;
  userId: string;
  /** Whose name the published commit carries as its author: the bot account's, or the requester's (given to the publish command by the Committer). */
  commitAs: 'bot' | 'requester';
}

export interface ProjectCredentialsProvider extends ProviderImpl {
  id: 'project.credentials';
  /**
   * Store (or replace) the token of the project named `projectName`, together with the repository address it was issued for and the project's main branch (the only branch a pull request may be aimed at): a reader compares that
   * address with the one it is about to use, so a token can never follow a project to another repository. Rejects when the cluster cannot be
   * reached; the message never holds the token.
   */
  put(team: CredentialTeam, projectName: string, token: string, origin: string, branch: string, identity?: CredentialIdentity): Promise<void>;
  /** Forget the project's token; the Secret itself is deleted when no project has one left. Removing a token that is not there is not an error. */
  remove(team: CredentialTeam, projectName: string): Promise<void>;
  /**
   * The token and the address it was issued for, or null when the project has none. Only server code that talks to GitHub on the project's behalf calls this.
   * `refused` is true once the server has seen GitHub turn the token down (`setRefused`): callers stop using it until a new one is saved.
   */
  read(team: CredentialTeam, projectName: string): Promise<{ token: string; origin: string; branch: string; refused?: boolean; identity?: CredentialIdentity } | null>;
  /**
   * Keep one token for a GitHub owner of the team (`ownerKey` is `<host>/<owner>`, lower case, e.g. `github.com/acme`) and make every project in
   * `projects` use it, each for its own address and main branch (the same rule as `put`). Replaces the owner's earlier token, clears its refused mark and
   * replaces any token a listed project had of its own. One change of the team's Secret: it is all there or none of it. An owner token that no project
   * uses any more is removed with the last project that used it. `drop` names projects whose token is removed in the same change. Rejects on a bad token, key or project, or when the cluster cannot be reached; the
   * message never holds the token.
   */
  putShared(team: CredentialTeam, ownerKey: string, token: string, projects: ReadonlyArray<{ name: string; origin: string; branch: string }>, drop?: ReadonlyArray<string>, identity?: CredentialIdentity): Promise<void>;
  /** Remember (or forget, when GitHub accepts the token again) that GitHub turned this project's token down; for a project on an owner token it is the owner token that is marked, so every project using it stops. Nothing happens when there is no token. */
  setRefused(team: CredentialTeam, projectName: string, refused: boolean): Promise<void>;
  /** Change whose name the project's published commit carries (`identity.commitAs`) without touching the token. Nothing happens when the project has no token. */
  setCommitAs(team: CredentialTeam, projectName: string, commitAs: 'bot' | 'requester'): Promise<void>;
}
