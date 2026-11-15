#!/bin/sh
# `mt-git` on the run container's PATH (P19-09): the only git a bot may run without a question. It checks the subcommand, its options and its paths, and runs git on the
# bot's own project folder with a clean environment (see mt-git.mjs). Anything else is refused with exit 2.
exec env -u NODE_OPTIONS -u NODE_PATH node /opt/claude-pod/mt-git.mjs "$@"
