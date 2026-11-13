import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  startFakeGithub,
  type FakeGithub,
} from "../../../test-utils/src/fake-github.ts";

// REVIEW-E: mt-publish.sh with MT_SOURCE_DIR (the publisher of a Claude or Codex pod) must not copy the clone's history into its scratch folder. In the pod that folder is a
// 32 MiB memory volume, so a project with a larger history could never be published (the fetch ran out of room and was reported as "the branch is not in the project folder"),
// and filling it could get the whole pod evicted. The private copy borrows the clone's objects instead; this test looks into the copy at the moment of the push.

const SCRIPT = fileURLToPath(
  new URL("../../../../deploy/images/workbench/mt-publish.sh", import.meta.url),
);
const TOKEN = "ghp_BorrowTest0123456789abcdefghijklmn";
const CARD = "1a2b3c4d-1111-4222-8333-444455556666";
const BRANCH = "card-1a2b3c4d";
const ORIGIN = "https://github.com/acme/widgets.git";
const ME = userInfo().username;
const REAL_GIT = spawnSync("sh", ["-c", "command -v git"], {
  encoding: "utf8",
}).stdout.trim();

const git = (cwd: string, ...args: string[]): string => {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

let root: string;
let gh: FakeGithub;

beforeAll(async () => {
  gh = await startFakeGithub({ token: TOKEN, owner: "acme", repo: "widgets" });
  root = mkdtempSync(join(tmpdir(), "pub-borrow-"));
});
afterAll(async () => {
  await gh.stop();
  rmSync(root, { recursive: true, force: true });
});

describe("mt-publish.sh with a working clone", () => {
  it("pushes from a private copy that borrows the clone’s objects and holds only the commit it made", async () => {
    const clone = join(root, "work/team-a/builder/widgets");
    mkdirSync(clone, { recursive: true });
    git(clone, "init", "-q", "-b", "main");
    // a history of some weight (4 MiB that does not compress): copied, it would show as a pack in the private copy
    writeFileSync(join(clone, "big.bin"), randomBytes(4 * 1024 * 1024));
    git(clone, "add", ".");
    git(clone, "commit", "-q", "-m", "first");
    git(clone, "remote", "add", "origin", ORIGIN);
    git(clone, "switch", "-q", "-c", BRANCH);
    writeFileSync(join(clone, "a.txt"), "two\n");
    git(clone, "add", ".");
    git(clone, "commit", "-q", "-m", "the change");
    const head = git(clone, "rev-parse", "HEAD");
    git(root, "init", "-q", "--bare", "-b", "main", "origin.git");
    const main = git(clone, "rev-parse", "main");
    git(clone, "push", "-q", join(root, "origin.git"), "main"); // the origin has the project's main branch

    const push = join(root, "push");
    mkdirSync(push, { mode: 0o700 });
    writeFileSync(
      join(push, "widgets"),
      JSON.stringify({ branch: "main", origin: ORIGIN, token: TOKEN }),
      { mode: 0o400 },
    );

    // a `git` in front of the real one: at `push`, it notes how many object files the repository it runs in holds of its own
    const bin = join(root, "bin");
    const seen = join(root, "seen.txt");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "git"),
      `#!/bin/bash\nif [ "$1" = -C ] && [[ " $* " == *" push "* ]]; then find "$2/objects" -type f ! -path '*/info/*' | wc -l > ${JSON.stringify(seen)}; cat "$2/objects/info/alternates" >> ${JSON.stringify(seen)} 2>/dev/null; fi\nexec ${JSON.stringify(REAL_GIT)} "$@"\n`,
    );
    chmodSync(join(bin, "git"), 0o755);

    const scratch = join(root, "scratch");
    mkdirSync(scratch);
    // spawned, not spawnSync: the double of GitHub answers from this same process
    const r = await new Promise<{ status: number | null; stderr: string }>(
      (done) => {
        const child = spawn(
          "bash",
          [SCRIPT, "publish", "widgets", CARD, head, "Fix the widget"],
          {
            env: {
              PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`,
              HOME: scratch,
              TMPDIR: scratch,
              MT_SOURCE_DIR: clone,
              MT_PUSH_DIR: push,
              MT_REPO_USER: ME,
              MT_PUSH_URL: join(root, "origin.git"),
              MT_GITHUB_API: gh.url,
              MT_PR_TRIES: "2",
              MT_PR_WAIT: "0",
            },
          },
        );
        let stderr = "";
        child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
        child.stdout.resume();
        child.on("close", (status) => done({ status, stderr }));
        child.stdin.end("Tested.\n");
      },
    );
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    // the origin got ONE new commit on its main branch (the squash of the card), not the clone's own commit
    const made = git(join(root, "origin.git"), "rev-parse", `refs/heads/${BRANCH}`);
    expect(made).not.toBe(head);
    expect(git(join(root, "origin.git"), "rev-parse", `${made}^`)).toBe(main);
    const [count, alternates] = readFileSync(seen, "utf8").trim().split("\n");
    // the copy holds the objects it made itself (that one commit; the history is borrowed): never a copy of the 4 MiB the clone holds
    expect(Number(count)).toBeLessThanOrEqual(2);
    expect(alternates).toBe(join(clone, ".git/objects"));
  });
});
