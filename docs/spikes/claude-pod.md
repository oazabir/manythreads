# P19-01 spike: Claude Code in a pod

Each answer is marked: [docs/code] from the CLI's documentation or this repository's code, [real CLI] needs the real program and a real sign-in, not yet done.

- Which program runs the bot: the agent bridge (`tools/agent-bridge`) starts `claude` per run. [docs/code]
- Where the sign-in lives: `.credentials.json` in the CLI's home on the state volume; the pod copies it from a Secret when missing. [docs/code]
- How the bridge runs: `node --experimental-transform-types` (strip-only mode fails on constructor parameter properties). [code, checked]
- Health: `/health` needs the key, so Kubernetes probes use TCP. [code, checked]
- Profiles are named `<team>--<bot>`. [code]
- Image size and build: not built in this round (disk). [real CLI / docker]
- The real error text for an expired sign-in and for a plan limit: the stand-in uses its own words (FAKE401, FAKELIMIT). [real CLI]
- Which hosts the CLI needs on 443 (so egress can be narrowed from public 443): [real CLI]
- Whether a refreshed token is written back to `.credentials.json` inside the pod, and how often: [real CLI]
- Several runs at once on one sign-in: assumed fine up to 4; the real plan limit is [real CLI].
