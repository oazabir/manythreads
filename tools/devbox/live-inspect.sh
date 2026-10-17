#!/usr/bin/env bash
# live-inspect.sh — runs ON the devbox. Read-only probes of the demo deployment:
#   bash tools/devbox/live-inspect.sh fake-state   # fake-llm /state via the server pod
#   bash tools/devbox/live-inspect.sh hind-state   # fake-hindsight /state via the server pod
#   bash tools/devbox/live-inspect.sh hermes       # hermes binary in the server image
#   bash tools/devbox/live-inspect.sh gate-rows     # sentinel run + bots + recent approvals (read-only)
#   bash tools/devbox/live-inspect.sh test-owner create <pw>  # scratch SUPERUSER for vitest (dropped after; devbox only)
#   bash tools/devbox/live-inspect.sh test-owner drop
set -euo pipefail
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
case "${1:-}" in
  fake-state)
    kubectl -n manythreads exec deploy/manythreads-server -- node --input-type=module -e "
const r = await fetch('http://manythreads-fake-llm:4000/state');
const s = await r.json();
console.log('models:', s.models.map((m) => m.model_name).join(','));
console.log('fallbacks:', JSON.stringify(s.fallbacks));
console.log('keys:', s.keys.map((k) => k.key.slice(0, 12) + '... models=' + k.models.join(',')).join(' | '));
console.log('calls:', s.calls);
"
    ;;
  hind-state)
    kubectl -n manythreads exec deploy/manythreads-server -- node --input-type=module -e "
const r = await fetch('http://manythreads-fake-hindsight:8888/state');
const s = await r.json();
console.log('banks:', Object.keys(s.banks).join(', ') || '(none)');
for (const [b, facts] of Object.entries(s.banks)) console.log(' ', b, JSON.stringify(facts).slice(0, 600));
console.log('calls:', s.calls.length);
"
    ;;
  hermes)
    kubectl -n manythreads exec deploy/manythreads-server -- /home/node/.local/bin/hermes --version
    ;;
  gate-repro)
    kubectl -n manythreads exec manythreads-pg-1 -- psql -U postgres -d manythreads -t -A -F '|' -c "BEGIN; SELECT set_config('app.actor_id', (SELECT a.id::text FROM app.actors a JOIN app.bots b ON a.ref_id = b.id WHERE a.kind = 'bot' AND b.slug = 'sentinel'), true), set_config('app.run_id', '01a13c3a-f30d-736a-8247-8bde19689c9a', true), set_config('app.workspace_id', '00000000-0000-7000-8000-00000000a001', true); SAVEPOINT repro; SELECT * FROM app.approvals_request('01a13c3a-f30d-736a-8247-8bde19689c9a', 'dlp', 'llm.gate', 'Message held by the gate', '{}', false, '{\"kind\":\"handoff\",\"payload\":{\"x\":1}}', NULL, NULL); ROLLBACK;"
    ;;
  test-owner)
    case "${2:-}" in
      create)
        kubectl -n manythreads exec manythreads-pg-1 -- psql -U postgres -d manythreads -t -A -c "CREATE ROLE test_owner SUPERUSER LOGIN PASSWORD '$3'"
        echo "test_owner ready"
        ;;
      drop)
        kubectl -n manythreads exec manythreads-pg-1 -- psql -U postgres -d manythreads -t -A \
          -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'test_owner' AND pid <> pg_backend_pid()" \
          -c "DROP ROLE IF EXISTS test_owner"
        echo "test_owner dropped"
        ;;
      *)
        echo "usage: live-inspect.sh test-owner <create <pw>|drop>"
        exit 2
        ;;
    esac
    ;;
  test-env)
    PW=$(openssl rand -hex 16)
    kubectl -n manythreads exec manythreads-pg-1 -- psql -U postgres -d manythreads -t -A -c "CREATE ROLE test_owner SUPERUSER LOGIN PASSWORD '$PW'"
    printf 'MANYTHREADS_TEST_DATABASE_URL=postgresql://test_owner:%s@10.43.229.244:5432/manythreads\n' "$PW" > /root/.mt-test-env
    chmod 600 /root/.mt-test-env
    echo "test env ready"
    ;;
  testdb)
    case "${2:-}" in
      up)
        kubectl create namespace testrun --dry-run=client -o yaml | kubectl apply -f -
        kubectl -n testrun run scratch-pg --image=manythreads/postgres:19 --image-pull-policy=IfNotPresent \
          --env=POSTGRES_USER=manythreads_owner --env=POSTGRES_PASSWORD=manythreads --env=POSTGRES_DB=manythreads --port=5432
        kubectl -n testrun wait --for=condition=ready pod/scratch-pg --timeout=180s
        pkill -f 'port-forward.*scratch-pg' || true
        nohup kubectl -n testrun port-forward pod/scratch-pg 55432:5432 > /tmp/pf-testdb.log 2>&1 < /dev/null &
        sleep 3
        printf 'MANYTHREADS_TEST_DATABASE_URL=postgresql://manythreads_owner:manythreads@localhost:55432/manythreads\n' > /root/.mt-test-env
        chmod 600 /root/.mt-test-env
        echo "scratch postgres ready"
        ;;
      down)
        pkill -f 'port-forward.*scratch-pg' || true
        kubectl delete namespace testrun --ignore-not-found
        rm -f /root/.mt-test-env
        echo "scratch postgres gone"
        ;;
      *)
        echo "usage: live-inspect.sh testdb <up|down>"
        exit 2
        ;;
    esac
    ;;
  test-run)
    set -a
    . /root/.mt-test-env
    set +a
    cd /root/manythreads
    rm -f /tmp/vt-run.log
    case "${3:-}" in
      PATTERN=*)
        FILES="$2"
        EXTRA="-t ${3#PATTERN=}"
        ;;
      "")
        FILES="$2"
        EXTRA=""
        ;;
      *)
        FILES="$2 $3"
        EXTRA=""
        ;;
    esac
    # shellcheck disable=SC2086
    nohup pnpm vitest run --project unit $FILES $EXTRA > /tmp/vt-run.log 2>&1 < /dev/null &
    echo "started $!"
    ;;
  test-kill)
    pkill -f 'vitest run' || true
    echo killed
    ;;
  test-log)
    tail -c 4000 /tmp/vt-run.log
    ;;
  deploy-check)
    kubectl -n manythreads exec deploy/manythreads-server -- grep -c SAVEPOINT packages/plugins/approvals/src/provider.ts
    kubectl -n manythreads exec deploy/manythreads-server -- grep -c ROLLBACK packages/plugins/approvals/src/provider.ts
    ;;
  gate-rows)
    kubectl -n manythreads exec manythreads-pg-1 -- psql -U postgres -d manythreads -t -A -F '|' -c "SELECT column_name FROM information_schema.columns WHERE table_schema = 'app' AND table_name = 'bot_runs' ORDER BY ordinal_position" -c "SELECT * FROM app.bot_runs WHERE id = '01a13c3a-f30d-736a-8247-8bde19689c9a'" -c "SELECT count(*) FROM app.approvals"
    ;;
  *)
    echo "usage: live-inspect.sh <fake-state|hind-state|hermes>"
    exit 2
    ;;
esac
