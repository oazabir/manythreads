#!/bin/sh
# STAND-IN for the Claude ACP adapter (claude-pod-fake; P27-19): the fake ACP agent (tools/fake-acp-agent, bundled to /opt/fake-acp/agent.mjs) as the `claude` flavor. It starts
# signed out and its terminal sign-in (`--cli auth login --claudeai`, which the bridge runs for the Runners page and the setup wizard) accepts the one code in
# $FAKE_SIGNIN_CODE (default `stand-in-code#stand-in`); any other code is refused like the real program refuses it. The sign-in is kept in the pod's sign-in folder, so it survives a restart.
export FAKE_ACP_FLAVOR=claude FAKE_ACP_SIGNED_OUT=1
export FAKE_ACP_SIGNIN_CODE="${FAKE_SIGNIN_CODE:-stand-in-code#stand-in}"
export FAKE_ACP_STATE_DIR="${CLAUDE_CONFIG_DIR:-/state/claude}/fake-acp"
exec node "${FAKE_ACP_BUNDLE:-/opt/fake-acp/agent.mjs}" "$@"
