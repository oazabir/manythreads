#!/bin/sh
# `mt-publish` on the run container's PATH (P19-09): asks the pod's publisher container to push the bot's work as one commit and open the pull request (GitHub) or merge request (GitLab). The bot never holds the
# team's token; the publisher reads it, and learns which team and bot this run belongs to from the platform, not from this command line.
#   mt-publish check <project>
#   mt-publish publish <project> <card id> <tested commit> <title> [<author name> <author email>]      (the request's text on standard input; the author is
#       the person who asked: the project may need it, and says so by refusing without it)
exec node /opt/claude-pod/publisher.mjs client "$@"
