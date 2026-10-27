#!/bin/bash
# git's GIT_ASKPASS helper for mt-publish.sh: answers git's "Username" prompt with a fixed name and its "Password" prompt with the token in the file
# MT_TOKEN_FILE. The token never appears in a command line or a git URL (other users of the pod can read those from /proc); only the process of the
# `repo` user that mt-publish.sh starts can read the file (a JSON document: the token and the repository address it was issued for).
case "${1:-}" in
  Username*) printf '%s\n' x-access-token ;;
  Password*) [ -n "${MT_TOKEN_FILE:-}" ] && [ -r "$MT_TOKEN_FILE" ] && jq -j '.token // empty' -- "$MT_TOKEN_FILE" ;;
  *) exit 1 ;;
esac
