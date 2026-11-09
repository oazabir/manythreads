#!/usr/bin/env bash
# stage-runners-probe.sh — runs ON the devbox, against the THROWAWAY stage release only (PLAN P19-12, owner decisions O2 and O7, Bundle E blocker 5). It proves from real pods what the
# automated tests prove from stand-ins: that a runner's pod cannot be used to reach the cluster, the node's metadata or the office network, that no sign-in byte shows up where an admin or an
# operator looks (describe, events, logs, environment, command line), that each service account may do exactly what docs/plugins/security.md lists, and that "Remove sign-in" leaves no login behind.
#
# It touches ONLY the namespaces `manythreads-stage` and `manythreads-stage-bots` (fixed names; no variable changes them: a value that names any other namespace is refused before the first
# kubectl call), with the FAKE pod image (a made-up sign-in file with canary strings; no real login exists on the stage). It never touches `manythreads` or `manythreads-bots`.
#
# Usage (after `STAGE_PROFILE=runners tools/devbox/stage.sh up`, see docs/runbooks/runners-live.md, "Stage proof"):
#   tools/devbox/stage-runners-probe.sh image    # build manythreads/claude-pod-fake:stage into k3s (the profile's claudePod.fakeImage); do this BEFORE stage.sh up
#   tools/devbox/stage-runners-probe.sh seed     # the runners world (seed v19) through the real routes: six runners, six bots, two made-up Claude logins
#   tools/devbox/stage-runners-probe.sh check    # every probe below; prints PASS / FAIL per line; exit 1 when one fails
#   tools/devbox/stage-runners-probe.sh remove   # "Remove sign-in" on the first Claude runner, then checks that no Secret and no state claim holds the login (changes the stage: run last)
#
# What `check` looks at, for every Claude and Codex pod in the stage's pods namespace:
#   network   from the RUN container: the Kubernetes API answers no request (no connection, or a refusal without a token), 169.254.169.254 and an unlisted private host do not connect;
#             positive controls: the server (allowed) connects, and the made-up sign-in file really is in the run container (so "not found" below means something)
#   leaks     `kubectl describe` of the pod and its Deployment, the pod and Deployment YAML, the events, the logs of every container, the run container's environment and command line
#             (/proc/*/environ and /proc/*/cmdline of every container, read INSIDE the stage's pod) hold none of: the canary, `fake-access-`, `fake-refresh-`
#   mounts    the sign-in Secret is mounted only by the init step; the keeper's token only by the keeper; the pod has no token of its own
#   rights    `kubectl auth can-i --as=...` for the keeper service account of each pod and for the server's: the table of docs/plugins/security.md, "Rights of the runner pods"
# Nothing here prints a value read from a pod: only counts, names of files and PASS / FAIL.
#
# Variables: KUBECTL (kubectl), DOCKER (docker), K3S (k3s) and TAG (stage) are for the tests of this script; STAGE_HOST (10.0.2.15) and FAKE_SAAS_PORT (18090) name the "unlisted private host" the probe
# tries (the stand-ins' address on the devbox, which answers from the devbox itself); STAGE_API_PORT (18081) and STAGE_STATE_DIR (/tmp/manythreads-stage) as in stage.sh.
set -euo pipefail
shopt -s lastpipe  # the last command of a pipeline runs in this shell, so the leak checks below can count their failures
cd "$(dirname "$0")/../.."
export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"

readonly STAGE_NS="manythreads-stage"
readonly BOTS_NS="manythreads-stage-bots"
# Refused before any kubectl, docker or k3s call: a variable that names a namespace other than the two above (the live ones above all).
for v in STAGE_NAMESPACE STAGE_BOTS_NAMESPACE NAMESPACE; do
  val="${!v:-}"
  if [ -n "$val" ] && [ "$val" != "$STAGE_NS" ] && [ "$val" != "$BOTS_NS" ]; then
    printf 'FAILED: %s=%s: this script works only in %s and %s (it never touches another namespace)\n' "$v" "$val" "$STAGE_NS" "$BOTS_NS" >&2
    exit 1
  fi
done
KUBECTL="${KUBECTL:-kubectl}"
DOCKER="${DOCKER:-docker}"
K3S="${K3S:-k3s}"
TAG="${TAG:-stage}"
HOST="${STAGE_HOST:-10.0.2.15}"
FAKE_PORT="${FAKE_SAAS_PORT:-18090}"
API_PORT="${STAGE_API_PORT:-18081}"
STATE="${STAGE_STATE_DIR:-/tmp/manythreads-stage}"
# The made-up values of the stage's sign-in files (packages/test-utils/src/seed-runners.ts): the canary and the two token prefixes.
PATTERNS='CANARY-SEEDRUNNERS-3c8d fake-access- fake-refresh-'

# Every call is namespaced by one of these two (or is a read of a cluster-wide kind): there is no way to ask for another namespace.
kb() { "$KUBECTL" -n "$BOTS_NS" "$@"; }
ks() { "$KUBECTL" -n "$STAGE_NS" "$@"; }

FAILS=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; FAILS=$((FAILS + 1)); }
info() { printf '      %s\n' "$1"; }
step() { printf '\n=== %s ===\n' "$1"; }
die() { printf 'FAILED: %s\n' "$1" >&2; exit 1; }

# ---- image --------------------------------------------------------------------------------------------------------------------------------------------
cmd_image() {
  local free_gb
  free_gb=$(df -BG --output=avail / | tail -n 1 | tr -dc '0-9')
  [ "${free_gb:-0}" -ge 10 ] || die "only ${free_gb}G free on /; free some space first (devbox.md)"
  local stage
  stage=$(mktemp -d)
  # the same staged folder deploy.sh builds the fake pod image from (the bridge's source, the pod scripts, the stand-in claude and codex)
  cp -r deploy/images/claude-pod/. "$stage/"
  cp deploy/images/workbench/mt-publish.sh deploy/images/workbench/mt-askpass.sh "$stage/"
  mkdir -p "$stage/bridge"
  cp -r tools/agent-bridge/src "$stage/bridge/src"
  cp deploy/images/claude-pod-fake/Dockerfile deploy/images/claude-pod-fake/fake-claude.mjs deploy/images/claude-pod-fake/fake-codex.mjs "$stage/"
  step "build manythreads/claude-pod-fake:$TAG"
  "$DOCKER" build -f "$stage/Dockerfile" -t "manythreads/claude-pod-fake:$TAG" "$stage"
  rm -rf "$stage"
  "$DOCKER" save "manythreads/claude-pod-fake:$TAG" | "$K3S" ctr -n k8s.io images import - | tail -n 2
  "$DOCKER" rmi "manythreads/claude-pod-fake:$TAG" >/dev/null 2>&1 || true
  echo "done: the image is in k3s; values-stage-runners.yaml names it (claudePod.fakeImage)"
}

# ---- seed ---------------------------------------------------------------------------------------------------------------------------------------------
cmd_seed() {
  local sys_pw
  sys_pw=$(ks get secret manythreads-db-system -o jsonpath='{.data.password}' | base64 -d)
  curl -fsS -o /dev/null "http://127.0.0.1:$API_PORT/readyz" || die "the stage server does not answer on 127.0.0.1:$API_PORT (is the stage up? stage.sh status)"
  STAGE_SERVER_URL="http://127.0.0.1:$API_PORT" STAGE_SYSTEM_DATABASE_URL="postgres://manythreads_system:$sys_pw@127.0.0.1:15432/manythreads" \
    pnpm exec tsx tools/devbox/stage-seed-runners.ts seed
}

# ---- helpers for check --------------------------------------------------------------------------------------------------------------------------------
# The pods of the stage's pods namespace made by the Claude pods controller: "<deployment> <ready>" one per line.
pods() { kb get deploy -l app.kubernetes.io/component=claude-pod -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}'; }

# In-container probes (node is in the pod image). They print one word and never a value read from the pod.
NODE_CONNECT='const n=require("net");const [h,p,t]=process.argv.slice(1);const s=n.connect({host:h,port:+p,timeout:+t});s.on("connect",()=>{console.log("open");process.exit(0)});s.on("timeout",()=>{console.log("timeout");process.exit(1)});s.on("error",e=>{console.log("error "+e.code);process.exit(1)})'
# The Kubernetes API with NO token: prints the HTTP status, or the word for why there was none.
NODE_API='const h=require("https");const host=process.env.KUBERNETES_SERVICE_HOST;const port=process.env.KUBERNETES_SERVICE_PORT||"443";if(!host){console.log("no-address");process.exit(1)}const r=h.get({host,port,path:"/api",rejectUnauthorized:false,timeout:5000},(res)=>{console.log("status "+res.statusCode);res.resume();res.on("end",()=>process.exit(0))});r.on("timeout",()=>{console.log("timeout");r.destroy();process.exit(1)});r.on("error",e=>{console.log("error "+e.code);process.exit(1)})'
# Counts, per pattern, of the processes of THIS container (not the probe's own process, whose command line names the patterns) whose environment or command line holds it. Prints "<what> <count>" lines; never the bytes.
NODE_PROC='const fs=require("fs");const pats=process.argv.slice(1);const hits={};let procs=0;for(const d of fs.readdirSync("/proc")){if(!/^\d+$/.test(d)||d===String(process.pid))continue;for(const f of ["environ","cmdline"]){let b;try{b=fs.readFileSync("/proc/"+d+"/"+f,"latin1")}catch{continue}if(f==="environ")procs++;for(const p of pats){if(b.includes(p)){const k=f+" "+p;hits[k]=(hits[k]||0)+1}}}}console.log("processes "+procs);for(const [k,v] of Object.entries(hits))console.log("hit "+k+" "+v)'

# Runs in one container of a pod. -c <container>. stderr dropped: an error text could name a path, never a value, but there is nothing to learn from it here.
in_pod() { local deploy=$1 container=$2; shift 2; kb exec "deploy/$deploy" -c "$container" -- "$@" 2>/dev/null; }

# Counts, over the text on stdin, the patterns it holds. Output "<pattern> <count>" for each pattern found; nothing for a clean text.
grep_patterns() {
  local text found=0
  text=$(cat)
  for p in $PATTERNS; do
    local n
    n=$(printf '%s' "$text" | grep -c -F -- "$p" || true)
    if [ "${n:-0}" -gt 0 ]; then printf '%s %s\n' "$p" "$n"; found=1; fi
  done
  return $found
}

# Prints "OK" or the patterns found for the text of a kubectl read.
leak_check() {
  local label=$1 out
  if out=$(grep_patterns); then pass "$label holds no sign-in byte"; else fail "$label holds sign-in bytes: $(printf '%s' "$out" | tr '\n' ' ')"; fi
}

# Whether a connect or a request from the RUN container "failed" in the sense of the proof: no connection, or (for the API) an answer without a token that is a refusal.
expect_closed() {
  local label=$1 answer=$2
  case "$answer" in
    open*) fail "$label: the run container connected" ;;
    status\ 200*) fail "$label: the run container was answered with data ($answer)" ;;
    status\ 401* | status\ 403*) pass "$label: reachable but refused without a token ($answer); the run container has no token" ;;
    error* | timeout*) pass "$label: no connection ($answer)" ;;
    *) fail "$label: the probe itself did not run (answer: ${answer:-none})" ;;
  esac
}

can_i() {
  # NOTE: a subresource is asked with --subresource=<name>. `pods/log` is kubectl's TYPE/NAME form (the pod named "log"), which any role that can read pods answers yes to.
  # can_i <yes|no> <label> <service account> <kubectl auth can-i words...>; the namespace is the pods namespace unless the words carry -n
  local want=$1 label=$2 sa=$3 got
  shift 3
  got=$("$KUBECTL" auth can-i --as="system:serviceaccount:$sa" "$@" 2>/dev/null || true)
  got=${got%%$'\n'*}
  if [ "$got" = "$want" ]; then pass "can-i $label: $got"; else fail "can-i $label: expected $want, got ${got:-nothing}"; fi
}

# ---- check --------------------------------------------------------------------------------------------------------------------------------------------
cmd_check() {
  local list
  list=$(pods)
  [ -n "$list" ] || die "no Claude or Codex pod in $BOTS_NS (did you run: stage-runners-probe.sh seed, and did the pods start? kubectl -n $BOTS_NS get pods)"
  local deploy
  for deploy in $list; do
    step "pod $deploy"
    local ready
    ready=$(kb get deploy "$deploy" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || true)
    if [ "${ready:-0}" -lt 1 ]; then
      info "not running (no sign-in file yet, or the pod is still starting): the network and environment probes need a running pod, the static ones follow"
    else
      # ---- network, from the run container ----------------------------------------------------------------------------------------------------------
      expect_closed "the Kubernetes API" "$(in_pod "$deploy" bridge node -e "$NODE_API" || true)"
      expect_closed "169.254.169.254 (node metadata)" "$(in_pod "$deploy" bridge node -e "$NODE_CONNECT" 169.254.169.254 80 4000 || true)"
      expect_closed "an unlisted private host ($HOST:$FAKE_PORT)" "$(in_pod "$deploy" bridge node -e "$NODE_CONNECT" "$HOST" "$FAKE_PORT" 4000 || true)"
      local ctl
      ctl=$(in_pod "$deploy" bridge node -e "$NODE_CONNECT" manythreads-server."$STAGE_NS".svc 3000 5000 || true)
      case "$ctl" in open*) pass "control: the server is reachable from the run container (so the closed doors above are closed on purpose)" ;; *) fail "control: the server is NOT reachable from the run container ($ctl); the probes above prove nothing" ;; esac
      # the keeper is the one container that must reach the API (it patches its Secret with its own token): the path is open, and without a token it is refused
      local keeper_api
      keeper_api=$(in_pod "$deploy" keeper node -e "$NODE_API" || true)
      case "$keeper_api" in
        status\ 401* | status\ 403* | status\ 200*) pass "keeper renews: the keeper container reaches the Kubernetes API ($keeper_api without a token), so a renewed login can be copied back" ;;
        *) fail "keeper renews: the keeper container cannot reach the Kubernetes API (${keeper_api:-no answer}); a renewed login would not be copied back and the pod would lose its sign-in (the network policy needs a rule for the API server's node address)" ;;
      esac
      # the host-side control: the "unlisted" host really answers (otherwise a closed door proves nothing)
      if curl -fsS -m 5 -o /dev/null "http://$HOST:$FAKE_PORT/" 2>/dev/null || curl -sS -m 5 -o /dev/null "http://$HOST:$FAKE_PORT/" 2>/dev/null; then pass "control: $HOST:$FAKE_PORT answers from the devbox"; else info "control: $HOST:$FAKE_PORT does not answer from the devbox either (start the stage with stage.sh up first)"; fi
      # ---- the sign-in really is there, and still not in the environment ---------------------------------------------------------------------------
      local file
      file=$(in_pod "$deploy" bridge sh -c 'for f in /state/claude/.credentials.json /state/codex/auth.json; do [ -s "$f" ] && echo present && exit 0; done; echo missing' || true)
      if [ "$file" = present ]; then pass "control: the sign-in file is in the run container's state folder"; else fail "control: no sign-in file in the run container (seed it first); the environment probes below prove nothing"; fi
      local container out
      for container in bridge keeper repo-sync publisher; do
        out=$(in_pod "$deploy" "$container" node -e "$NODE_PROC" $PATTERNS || true)
        if [ -z "$out" ]; then
          [ "$container" = publisher ] && info "container publisher: not in this pod or has no node; skipped" || fail "container $container: the process probe did not run"
          continue
        fi
        if printf '%s' "$out" | grep -q '^hit '; then fail "container $container: sign-in bytes in $(printf '%s' "$out" | grep '^hit ' | tr '\n' ';')"; else pass "container $container: no sign-in byte in the environment or the command line of its $(printf '%s' "$out" | sed -n 's/^processes //p') processes"; fi
      done
      # the run container's own environment, by NAME: nothing named for a token or a login (the bridge key is the one secret it holds, named AGENT_BRIDGE_API_KEY)
      local names
      names=$(in_pod "$deploy" bridge sh -c 'tr "\0" "\n" </proc/1/environ | cut -d= -f1' || true)
      if printf '%s\n' "$names" | grep -Ei 'refresh|access_?token|credential|oauth|auth_json|OPENAI_API_KEY|ANTHROPIC_API_KEY' >/dev/null; then fail "the run container's environment has a variable named for a token or login"; else pass "the run container's environment (/proc/1/environ, names only) has no variable named for a token or login"; fi
    fi
    # ---- what an operator can read -----------------------------------------------------------------------------------------------------------------
    kb describe pod -l "manythreads.io/pod=$deploy" 2>/dev/null | leak_check "kubectl describe of the pod"
    kb describe deploy "$deploy" 2>/dev/null | leak_check "kubectl describe of the Deployment"
    kb get pod,deploy,cm -l "manythreads.io/runner" -o yaml 2>/dev/null | leak_check "the pod, Deployment and ConfigMap YAML"
    kb get events 2>/dev/null | leak_check "the events"
    # A runner with no sign-in has no pod (0 replicas): `kubectl logs` then fails, and with pipefail that would end the whole check here without a word. No pod, no log to read.
    { kb logs "deploy/$deploy" --all-containers --tail=-1 2>/dev/null || true; } | leak_check "the logs of every container"
    { ks logs deploy/manythreads-server --tail=-1 2>/dev/null || true; } | leak_check "the server's log"
    # ---- mounts and tokens (the pod's own JSON; names of volumes only) ------------------------------------------------------------------------------
    local mounts
    mounts=$(kb get deploy "$deploy" -o json 2>/dev/null | node -e '
      let s=""; process.stdin.on("data",(d)=>s+=d).on("end",()=>{
        const spec=JSON.parse(s).spec.template.spec;
        const out=[];
        if(spec.automountServiceAccountToken!==false) out.push("automount-on");
        const users=(vol)=>[...(spec.initContainers||[]),...(spec.containers||[])].filter((c)=>(c.volumeMounts||[]).some((m)=>m.name===vol)).map((c)=>c.name).sort().join(",");
        out.push("creds="+users("creds"),"keeper-token="+users("keeper-token"));
        for(const v of spec.volumes||[]) if(/^push-/.test(v.name)) out.push(v.name+"="+users(v.name));
        console.log(out.join(" "));
      })' || true)
    case "$mounts" in
      *automount-on*) fail "the pod gets a Kubernetes token of its own (automountServiceAccountToken is not false)" ;;
      "") fail "could not read the volume mounts of $deploy" ;;
      *"creds=prepare "*) pass "mounts: the sign-in Secret only by the init step; $mounts" ;;
      *) fail "mounts: the sign-in Secret is mounted by more than the init step: $mounts" ;;
    esac
    case "$mounts" in *"keeper-token=keeper"*) pass "mounts: the keeper's token only by the keeper" ;; *) fail "mounts: the keeper's token is not mounted by the keeper alone: $mounts" ;; esac
    if printf '%s' "$mounts" | grep -E 'push-[0-9]+=' | grep -Ev 'push-[0-9]+=publisher( |$)' >/dev/null; then fail "mounts: a push Secret is mounted by a container other than the publisher: $mounts"; else pass "mounts: a push Secret (if any) only by the publisher"; fi

    # ---- rights of the pod's keeper service account ------------------------------------------------------------------------------------------------
    local base=$deploy sa creds key
    sa="$BOTS_NS:$base-keeper"
    creds="$base-credentials"
    key="$base-key"
    can_i yes "keeper may get its one credentials Secret" "$sa" -n "$BOTS_NS" get "secret/$creds"
    can_i yes "keeper may patch its one credentials Secret" "$sa" -n "$BOTS_NS" patch "secret/$creds"
    can_i no "keeper may not update it (patch only)" "$sa" -n "$BOTS_NS" update "secret/$creds"
    can_i no "keeper may not delete it" "$sa" -n "$BOTS_NS" delete "secret/$creds"
    can_i no "keeper may not read the bridge key Secret" "$sa" -n "$BOTS_NS" get "secret/$key"
    can_i no "keeper may not list Secrets" "$sa" -n "$BOTS_NS" list secrets
    can_i no "keeper may not create Secrets" "$sa" -n "$BOTS_NS" create secrets
    can_i no "keeper may not read another runner's Secret" "$sa" -n "$BOTS_NS" get "secret/not-$creds"
    can_i no "keeper may not read Secrets of the release namespace" "$sa" -n "$STAGE_NS" get secrets
    can_i no "keeper may not exec into a pod" "$sa" -n "$BOTS_NS" create pods --subresource=exec
    can_i no "keeper may not list nodes" "$sa" list nodes
  done

  # ---- the server's service account (the controllers) ---------------------------------------------------------------------------------------------------
  step "rights of the server's service account"
  local srv="$STAGE_NS:manythreads-server"
  can_i yes "controller may create Deployments in the pods namespace" "$srv" -n "$BOTS_NS" create deployments
  can_i yes "controller may create ServiceAccounts in the pods namespace" "$srv" -n "$BOTS_NS" create serviceaccounts
  can_i yes "controller may create Roles in the pods namespace" "$srv" -n "$BOTS_NS" create roles
  can_i yes "controller may create RoleBindings in the pods namespace" "$srv" -n "$BOTS_NS" create rolebindings
  can_i yes "controller may read Secrets in the pods namespace (to see whether a sign-in is there)" "$srv" -n "$BOTS_NS" get secrets
  can_i yes "controller may delete volume claims in the pods namespace (a move or Remove sign-in)" "$srv" -n "$BOTS_NS" delete persistentvolumeclaims
  can_i yes "controller may list nodes (the node picker)" "$srv" list nodes
  can_i no "controller may not delete Deployments" "$srv" -n "$BOTS_NS" delete deployments
  can_i no "controller may not delete ServiceAccounts" "$srv" -n "$BOTS_NS" delete serviceaccounts
  can_i no "controller may not delete Roles" "$srv" -n "$BOTS_NS" delete roles
  can_i no "controller may not exec into a pod" "$srv" -n "$BOTS_NS" create pods --subresource=exec
  can_i no "controller may not read pod logs" "$srv" -n "$BOTS_NS" get pods --subresource=log
  can_i no "controller may not change nodes" "$srv" patch nodes
  can_i no "controller may not read Secrets cluster-wide" "$srv" get secrets --all-namespaces
  can_i no "controller may not read Secrets in kube-system" "$srv" -n kube-system get secrets
  can_i no "controller may not create ClusterRoles" "$srv" create clusterroles
  can_i no "controller may not create Roles in the release namespace" "$srv" -n "$STAGE_NS" create roles

  step "result"
  if [ "$FAILS" -gt 0 ]; then printf '%s check(s) FAILED\n' "$FAILS"; exit 1; fi
  echo "all checks passed"
}

# ---- remove -------------------------------------------------------------------------------------------------------------------------------------------
# "Remove sign-in" on the first Claude runner, then: no credentials Secret and no state claim of that runner is left, and the pod's work claim is.
cmd_remove() {
  local runner=claude-shared base=claude-claude-shared
  kb get secret "$base-credentials" >/dev/null 2>&1 || die "no $base-credentials Secret: seed first (stage-runners-probe.sh seed)"
  STAGE_SERVER_URL="http://127.0.0.1:$API_PORT" pnpm exec tsx tools/devbox/stage-seed-runners.ts remove-signin "$runner"
  local waited=0
  # the state claim is deleted at once, but a claim in use stays "Terminating" until its pod stops; the controller stops the pod when the Secret is gone
  while kb get secret "$base-credentials" >/dev/null 2>&1 || kb get pvc "$base-state" >/dev/null 2>&1; do
    sleep 3
    waited=$((waited + 3))
    [ "$waited" -lt 180 ] || break
  done
  kb get secret "$base-credentials" >/dev/null 2>&1 && fail "the credentials Secret is still there after Remove sign-in" || pass "no credentials Secret after Remove sign-in"
  local pvc
  pvc=$(kb get pvc "$base-state" -o jsonpath='{.metadata.deletionTimestamp}' 2>/dev/null || true)
  if kb get pvc "$base-state" >/dev/null 2>&1; then
    # a claim the controller made again for the next sign-in is empty: it has no deletion mark and no pod holds the old one
    [ -n "$pvc" ] && fail "the state claim is still being deleted (a pod still holds the old login)" || info "the state claim was made again, empty, for the next sign-in"
  else
    pass "no state claim after Remove sign-in"
  fi
  [ "$FAILS" -eq 0 ] || exit 1
}

case "${1:-}" in
  image) cmd_image ;;
  seed) cmd_seed ;;
  check) cmd_check ;;
  remove) cmd_remove ;;
  *) echo "usage: stage-runners-probe.sh image | seed | check | remove"; exit 2 ;;
esac
