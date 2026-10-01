# MISTAKES — read before starting work; append when something goes wrong

Format: `- [phase/task] what went wrong → what to do instead`

- [P1 env] Raw TCP (ssh on :44033) is blocked from the sandbox → don't attempt direct SSH; use the deploy path in STATUS.md.
- [P1 env] Docker daemon is not running at container start → `(dockerd >/tmp/dockerd.log 2>&1 &)` first.
- [P1 env] There is no `postgres:19` tag yet → use `postgres:19beta4` as base.
