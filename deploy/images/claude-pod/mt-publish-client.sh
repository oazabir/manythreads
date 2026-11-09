#!/bin/sh
# `mt-publish` on the run container's PATH (P19-09): asks the pod's publisher container to push the bot's branch and open the pull request. The bot never holds the
# team's token; the publisher reads it, and learns which team and bot this run belongs to from the platform, not from this command line.
#   mt-publish check <project>
#   mt-publish publish <project> <card id> <tested commit> <title>      (the pull request's text on standard input)
exec node /opt/claude-pod/publisher.mjs client "$@"
