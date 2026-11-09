# Finding the sign-in file for a Claude Code or Codex runner

A **runner** is a place where a bot does its work (the Runners page, under Workspace settings). A Claude Code runner and a Codex runner each run the
real command-line tool of that company, and the tool needs to be signed in to a paid account. The tool keeps that sign-in in one small file on the
machine where someone signed in. A workspace admin uploads that file once on the Runners page; manythreads stores it exactly as it is, in the runner's own
secret in the cluster, and never shows it again.

This page says where the file is, which login to use, and what not to do. It is for the admin who sets a runner up.

## Use a login made for the runner

Make a fresh login on a spare machine (or a spare account) and upload that file. Do not upload the file of the login you work with every day.

The reason: the tool renews its access token from time to time, and renewing replaces the "refresh token" inside the file (a long-lived secret used only to
get a new access token). Two copies of one login, one on your laptop and one in the pod, will both try to renew; the one that renews second can be signed
out for good. This is also why the Runners page refuses the same login on a second runner: every Claude Code runner and every Codex runner needs its own
login.

The terms of the account matter too. A personal plan may not allow a whole team to use it through automation. Check the plan before you upload, and tick the
box on the upload form that says you did.

## Where the file is

### Claude Code: `.credentials.json`

| System | Where |
|---|---|
| Linux | `~/.claude/.credentials.json` (the `.claude` folder in your home folder) |
| Windows | `%USERPROFILE%\.claude\.credentials.json` (for example `C:\Users\you\.claude\.credentials.json`) |
| macOS | Not a file in the usual setup: the login is kept in the Keychain. **Not measured** (task P19-01, question e), so this page does not tell you a way to get a file out of the Keychain. Use a Linux or Windows machine for the login you upload. |

Sign in on that machine with `claude auth login` (or the first start of `claude`), then check that the file exists. The file holds the access token,
the refresh token, when the access token ends, the permissions the login has (it needs `user:inference`) and the plan. It can also hold the sign-ins of other
services that tool talks to (Notion, Slack, and so on). The upload form lists their names and asks you to tick that you know they go along, because the file
is stored without any change. A fresh login made for the runner has none of those, which is one more reason to make one.

### Codex: `auth.json`

| System | Where |
|---|---|
| Linux | `~/.codex/auth.json` |
| Windows | `%USERPROFILE%\.codex\auth.json` |
| macOS | `~/.codex/auth.json` when Codex keeps its login in a file. When it keeps it in the Keychain there is no file; this is **not measured** (task P19-01). |

Sign in with the ChatGPT account (the "Sign in with ChatGPT" choice of `codex login`), not with an API key. A file that holds an API key is refused
whole: a key would bypass the platform's own model gateway and its spend lines, and API keys are not part of this phase. The file must also say it is a
ChatGPT sign-in. The plan name shown on the upload form ("ChatGPT Pro plan") is read from the file in your browser; the server never keeps it.

## What manythreads does with the file

- The browser reads the file only to show you a summary (the plan, when it ends, which other sign-ins it holds). It sends the original bytes.
- The server checks the shape and stores the bytes unchanged in a Kubernetes secret that only that runner's pod reads. The database keeps the plan name, the
  end time, a checksum and a keyed hash of the login (to refuse a second runner with the same login). It does not keep the file or any token.
- When the tool renews the login inside the pod, a small helper container in the pod (the "keeper") copies the renewed file back into the secret, so a
  restart of the pod keeps the new login. Uploading a new file replaces it and restarts the pod.
- A canary check in the tests makes sure no token from a file shows up in any answer, event, audit entry or log line.

## What not to do

- Do not copy the file of a login you still use elsewhere (see the first section).
- Do not edit the file, trim the other sign-ins out, or paste it into a chat or a ticket. Upload it with the form.
- Do not upload a file from someone else's machine without their say-so.
- Do not run the check "does it work" on the Runners page before the pod is up; the page says "Waiting for sign-in" or "Starting" until it is.

## Trying the whole thing without a real login

The test and screenshot environments never use a real login. They use made-up files with the same shape (the access token starts with `fake-`) and a
stand-in for each command that answers like the real one. See [claude-pods](../plugins/claude-pods.md#stand-in-commands-and-the-seed) for how to build the
stand-in image and which words in a prompt make it refuse, hit a plan limit or renew the file.
