# fake-git-host (P27-19)

A small fake of GitHub for the setup journey and the engineering chain: the REST calls the Projects token check and `mt-publish` make, and real git over HTTP. No account, no network.

```ts
import { startFakeGitHost } from '../../tools/fake-git-host/src/index.ts';
const host = await startFakeGitHost({ token: 'ghp_test…', owner: 'acme', repos: ['starter'] });
host.apiUrl;            // REST base: MANYTHREADS_TEST_GITHUB_API, MT_GITHUB_API, a project's API base
host.remoteUrl('starter'); // http://127.0.0.1:<port>/acme/starter.git — clone and push with the token as the password
host.calls; host.gitCalls; // what was asked, in order (never a token)
host.branchHead('starter', 'card-1'); // the commit a pushed branch is at
await host.stop();
```

CLI: `FAKE_GIT_TOKEN=<token> tsx src/cli.ts [--owner=acme] [--repos=a,b]` prints `{ "apiUrl", "gitUrl" }` and runs until stopped.

Rules: only the one token is accepted (401 otherwise, for REST and git); a repository in `readOnlyRepos` says `push: false` and refuses a push; each repository starts with one commit on `main`.
Run the host in a spec's own process and call `git` with an async spawn: a blocking spawn stops the host from answering. See `docs/testing.md`, "Stand-ins for the setup journey".
