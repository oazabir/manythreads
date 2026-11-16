#!/bin/sh
# STAND-IN for the Codex ACP adapter (claude-pod-fake; P27-19): the fake ACP agent as the `codex` flavor, signed out at the start; its device-code sign-in finishes on its own.
export FAKE_ACP_FLAVOR=codex FAKE_ACP_SIGNED_OUT=1
export FAKE_ACP_STATE_DIR="${CODEX_HOME:-/state/codex}/fake-acp"
exec node "${FAKE_ACP_BUNDLE:-/opt/fake-acp/agent.mjs}" "$@"
