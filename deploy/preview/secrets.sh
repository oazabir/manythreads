#!/bin/sh
# Makes the Secrets a preview install needs before `helm upgrade --install`: the three database passwords, the key that encrypts stored provider
# secrets (the KMS master key) and the test token. Uses kubectl only, draws random values, and never prints one.
#
# Optional: the chart makes the same Secrets itself when they are missing. Run this script when you want them to exist (and be kept) before the
# first install, or after `kubectl delete secret` of all of them for a fresh start. A Secret that already exists is left untouched (so a rerun never
# rotates the key: losing the KMS key makes the encrypted values unreadable).
#
#   sh deploy/preview/secrets.sh [namespace]      # default: the namespace of the current kubectl context
#   RELEASE=manythreads                           # the Helm release name the Secrets are handed to (the chart's object names are fixed; keep it)
set -eu

RELEASE="${RELEASE:-manythreads}"
NS="${1:-$(kubectl config view --minify -o 'jsonpath={..namespace}')}"
[ -n "$NS" ] || { echo "usage: $0 <namespace>" >&2; exit 2; }

# n random letters and digits
rand_alnum() { LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c "$1"; }
# 32 random bytes, base64 (the KMS key's format: MANYTHREADS_KMS_KEY)
rand_key() { head -c 32 /dev/urandom | base64 | tr -d '\n'; }

# Exit 0 when the Secret exists, 1 when it does not; any other failure (no cluster, no permission, a timeout) stops the script, so an error is never
# mistaken for "not there" (which would go on to create, and so risk replacing, a Secret that is).
exists() {
  out=$(kubectl -n "$NS" get secret "$1" --ignore-not-found -o name) || { echo "cannot tell whether secret $1 exists in $NS" >&2; exit 1; }
  [ -n "$out" ]
}

# Helm adopts an object only when it carries its ownership marks, so every Secret is made with them.
apply() {
  # $1 = name; the manifest comes in on stdin (never on a command line, so it is not in `ps`). `create` fails if the Secret appeared meanwhile, so an
  # existing Secret is never overwritten; it keeps no copy of the values in an annotation either.
  kubectl -n "$NS" create -f - >/dev/null
  echo "created secret $1"
}

db_secret() {
  name="$1"; user="$2"
  if exists "$name"; then echo "kept secret $name"; return 0; fi
  pw="$(rand_alnum 32)"
  apply "$name" <<YAML
apiVersion: v1
kind: Secret
metadata:
  name: $name
  namespace: $NS
  labels:
    app.kubernetes.io/name: manythreads
    app.kubernetes.io/instance: $RELEASE
    app.kubernetes.io/managed-by: Helm
    cnpg.io/reload: "true"
  annotations:
    meta.helm.sh/release-name: $RELEASE
    meta.helm.sh/release-namespace: $NS
type: kubernetes.io/basic-auth
stringData:
  username: $user
  password: "$pw"
YAML
}

db_secret manythreads-db-owner  "${DB_OWNER:-manythreads_owner}"
db_secret manythreads-db-app    "${DB_APP:-manythreads_app}"
db_secret manythreads-db-system "${DB_SYSTEM:-manythreads_system}"

if exists manythreads-server-secrets; then
  echo "kept secret manythreads-server-secrets"
else
  kms="$(rand_key)"
  tok="$(rand_alnum 40)"
  apply manythreads-server-secrets <<YAML
apiVersion: v1
kind: Secret
metadata:
  name: manythreads-server-secrets
  namespace: $NS
  labels:
    app.kubernetes.io/name: manythreads
    app.kubernetes.io/instance: $RELEASE
    app.kubernetes.io/managed-by: Helm
  annotations:
    helm.sh/resource-policy: keep
    meta.helm.sh/release-name: $RELEASE
    meta.helm.sh/release-namespace: $NS
type: Opaque
stringData:
  kms-key: "$kms"
  test-auth-token: "$tok"
  kms-previous-keys: ""
YAML
fi
