#!/bin/bash
# Makes the workbench match its configuration; safe to run again and again (the entrypoint runs it every few seconds). Runs as root, so it
# treats everything under a bot's home as hostile: root only creates the home directory itself (in a root-owned parent a bot cannot swap),
# and every operation INSIDE a home is done as that bot's own user (runuser), so a symlink a bot plants can only point its own writes around.
#   /etc/workbench/bots.json        the bots (one Unix user each) and the repositories of record; a ConfigMap of the pod
#   /keys/<user>.pub               the public key the Hermes container made for that bot (the private half never leaves Hermes)
#   /etc/workbench-secret/deployer.kubeconfig   the namespace-scoped deployer credential, given to the deployer bot only
#   /etc/workbench-push/<project>  a project's GitHub token (a Secret of the pod); mt-push-sync.sh hands it to the `repo` user only
set -uo pipefail
CONF=/etc/workbench/bots.json
[ -s "$CONF" ] || exit 0
SECRET_KUBECONFIG=/etc/workbench-secret/deployer.kubeconfig
HOOK=/usr/local/share/workbench/hooks/update

/usr/local/bin/mt-lockdown.sh || exit 1
# the projects' GitHub tokens: root-only in the pod's Secret mount, copied for the `repo` user alone (what mt-publish.sh reads)
/usr/local/bin/mt-push-sync.sh || echo "push credentials: sync failed" >&2

# One-time scrub for a volume that predates the lockdown: ownership and modes inside each bot's home, done by the bot's own user
# (so no symlink can lead root or another user anywhere), and group-write / setgid bits removed.
if [ ! -e /workspace/.scrub-v2 ]; then
  for h in /workspace/bots/*; do
    [ -d "$h" ] && [ ! -L "$h" ] || continue
    u=$(stat -c %U "$h"); id "$u" >/dev/null 2>&1 || continue
    runuser -u "$u" -- bash -c 'chgrp -R -h bots "$HOME" 2>/dev/null; chmod -R go-rwx,g-s "$HOME" 2>/dev/null' || true
  done
  runuser -u repo -- bash -c 'chmod -R go-w /workspace/repos 2>/dev/null' || true
  : > /workspace/.scrub-v2
fi
mkdir -p /etc/ssh/authorized_keys
wanted=$(jq -r '.bots[].user' "$CONF")
origin_allow=$(jq -r '(.originAllow // []) | join(",")' "$CONF")

# users -------------------------------------------------------------------------------------------------------------------
jq -c '.bots[]' "$CONF" | while read -r bot; do
  user=$(jq -r .user <<<"$bot"); uid=$(jq -r .uid <<<"$bot"); deployer=$(jq -r '.deployer // false' <<<"$bot")
  [[ "$user" =~ ^[a-z][a-z0-9-]{0,30}$ ]] && [[ "$uid" =~ ^[0-9]{5}$ ]] || { echo "skip bad user entry: $user" >&2; continue; }
  home="/workspace/bots/$user"
  if [ -L "$home" ]; then echo "refusing $home: it is a symlink" >&2; continue; fi
  if ! id "$user" >/dev/null 2>&1; then
    useradd --uid "$uid" --gid bots --home-dir "$home" --no-create-home --shell /bin/bash --password '*' "$user" || continue
  else
    usermod --shell /bin/bash --password '*' "$user" >/dev/null 2>&1 || true
  fi
  [ -d "$home" ] || mkdir -- "$home"
  chown -h "$user:bots" "$home"; chmod 0700 "$home"
  runuser -u "$user" -- bash -c '[ -f "$HOME/.gitconfig" ] || { git config --global user.name "$(id -un)"; git config --global user.email "$(id -un)@bots.manythreads.local"; }'
  # publishing: only a bot whose definition grants tasks.pull_request is in the `publishers` group (the one sudo lets run mt-publish.sh)
  if [ "$(jq -r '.publisher // false' <<<"$bot")" = "true" ]; then usermod -aG publishers "$user" >/dev/null 2>&1 || true
  else gpasswd -d "$user" publishers >/dev/null 2>&1 || true; fi
  # ssh: the key Hermes made; root owns the file, so a bot cannot add a key of its own
  pub="/keys/$user.pub"
  if [ -s "$pub" ] && head -c 12 "$pub" | grep -q '^ssh-ed25519 '; then
    head -n 1 "$pub" > "/etc/ssh/authorized_keys/$user.tmp"
    chmod 0644 "/etc/ssh/authorized_keys/$user.tmp"; mv -f "/etc/ssh/authorized_keys/$user.tmp" "/etc/ssh/authorized_keys/$user"
  fi
  # the deployer credential: 0600, owned by the deployer bot, nobody else. Written BY the bot's own user from root's open file.
  if [ "$deployer" = "true" ] && [ -s "$SECRET_KUBECONFIG" ]; then
    runuser -u "$user" -- bash -c 'umask 077; if [ -L "$HOME/.kube" ]; then rm -f "$HOME/.kube"; fi; mkdir -p "$HOME/.kube" && chmod 0700 "$HOME/.kube" && cat > "$HOME/.kube/config.new" && chmod 0600 "$HOME/.kube/config.new" && mv -f "$HOME/.kube/config.new" "$HOME/.kube/config"' < "$SECRET_KUBECONFIG" || echo "deployer kubeconfig for $user failed" >&2
  else
    runuser -u "$user" -- bash -c 'rm -rf "$HOME/.kube"' || true
  fi
done

# bots that left the configuration: no login, no key (their files stay) --------------------------------------------------------
for u in $(getent group bots | cut -d: -f4 | tr ',' ' '); do
  if ! grep -qx "$u" <<<"$wanted"; then
    usermod --shell /usr/sbin/nologin "$u" >/dev/null 2>&1 || true
    gpasswd -d "$u" publishers >/dev/null 2>&1 || true
    rm -f "/etc/ssh/authorized_keys/$u"
    runuser -u "$u" -- bash -c 'rm -f "$HOME/.kube/config"' 2>/dev/null || true
  fi
done

# repositories of record (made and hook-installed by `repo`), and each bot's clone of them ---------------------------------------
jq -c '.repos[]?' "$CONF" | while read -r repo; do
  name=$(jq -r .name <<<"$repo"); origin=$(jq -r '.origin // ""' <<<"$repo"); branch=$(jq -r '.branch // ""' <<<"$repo")
  runuser -u repo -- env MT_ORIGIN_ALLOW="$origin_allow" /usr/local/bin/mt-repo-create.sh "$name" "$origin" "$branch" >/dev/null 2>&1 || { echo "repo $name: create failed" >&2; continue; }
  dir="/workspace/repos/$name.git"
  # keep the protecting hook current, and name this exact path as safe for git's ownership check (no wildcard)
  cmp -s "$HOOK" "$dir/hooks/update" || runuser -u repo -- install -m 0755 "$HOOK" "$dir/hooks/update"
  for user in $wanted; do
    id "$user" >/dev/null 2>&1 || continue
    runuser -u "$user" -- bash -c '[ -d "$HOME/'"$name"'/.git" ] || git clone --quiet "'"$dir"'" "$HOME/'"$name"'"' >/dev/null 2>&1 || true
  done
done
# every repository of record that exists (also those a bot made with mt-repo-create.sh): keep the hook current, name the exact path as safe
for dir in /workspace/repos/*.git; do
  [ -d "$dir" ] && [ ! -L "$dir" ] && [ "$(stat -c %U "$dir")" = repo ] || continue
  if [ -f "$dir/hooks/update" ] && ! cmp -s "$HOOK" "$dir/hooks/update"; then runuser -u repo -- install -m 0755 "$HOOK" "$dir/hooks/update"; fi
  git config --system --get-all safe.directory | grep -qx "$dir" || git config --system --add safe.directory "$dir"
done
exit 0
