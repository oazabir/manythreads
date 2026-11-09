#!/bin/sh
# Makes the .env file of a Docker Compose install: every password and key is generated here, once, and written to the file with mode 0600.
#
#   sh deploy/compose/make-env.sh                 writes deploy/compose/.env (stops if it exists)
#   sh deploy/compose/make-env.sh https://threads.example.org    the same, with the address people will use
#
# Nothing is printed except the file's name. Keep the file: the database passwords are fixed on the first start, and the KMS key decrypts every
# secret the install stores (lose it and they are gone; change it and `admin kms-rewrap` is needed).
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
OUT="$HERE/.env"
URL="${1:-http://localhost:3000}"
[ ! -e "$OUT" ] || { echo "$OUT exists; move it away first (the passwords in it are already in use by the database volume)." >&2; exit 1; }
command -v openssl >/dev/null || { echo "openssl is needed to make the keys." >&2; exit 1; }
hex() { openssl rand -hex 24; }
umask 077
{
  echo "# Made by deploy/compose/make-env.sh. Keep this file private; do not commit it."
  echo "MANYTHREADS_PUBLIC_URL=$URL"
  echo "POSTGRES_PASSWORD=$(hex)"
  echo "MANYTHREADS_APP_PASSWORD=$(hex)"
  echo "MANYTHREADS_SYSTEM_PASSWORD=$(hex)"
  echo "MANYTHREADS_KMS_KEY=$(openssl rand -base64 32)"
  echo "MANYTHREADS_LITELLM_MASTER_KEY=sk-$(hex)"
  echo "MANYTHREADS_LITELLM_SALT_KEY=sk-$(hex)"
  echo "MANYTHREADS_HINDSIGHT_API_KEY=hs-$(hex)"
  echo "MANYTHREADS_HINDSIGHT_DB_PASSWORD=$(hex)"
  echo "MANYTHREADS_HINDSIGHT_LLM_KEY=sk-$(hex)"
  echo "MANYTHREADS_HERMES_API_KEY=$(hex)"
  echo "MANYTHREADS_HERMES_LLM_KEY=sk-$(hex)"
} > "$OUT"
echo "wrote $OUT"
