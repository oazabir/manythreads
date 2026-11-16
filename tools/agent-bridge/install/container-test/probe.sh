#!/bin/sh
# Stands in for the agent's adapter in the container test: runs each line it is given as a shell command, as the user the helper started it as.
while IFS= read -r line; do sh -c "$line"; done
