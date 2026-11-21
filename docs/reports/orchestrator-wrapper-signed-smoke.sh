#!/bin/sh
# Run inside an enrolled disposable four-engine container with a synthetic
# home, private signing key and no subscription credentials.
set -eu
bin_dir=${1:?expected an absolute directory containing the five instrumented executable names}
export GOCOVERDIR=${2:?expected an absolute writable counter directory}
case "$bin_dir:$GOCOVERDIR" in /*:/*) ;; *) exit 2 ;; esac
for binary in cxx cdx clx cgx ckx; do test -x "$bin_dir/$binary"; done
mkdir -p "$GOCOVERDIR"
capture=$(mktemp)
trap 'rm -f "$capture"' EXIT HUP INT TERM
result=0
run() {
    label="$1"; expected="$2"; binary="$3"; shift 3
    status=0
    timeout -k 3 60 "$bin_dir/$binary" "$@" </dev/null >"$capture" 2>&1 || status=$?
    printf '%s\t%s\n' "$label" "$status"
    case "$expected" in
        ok) test "$status" -eq 0 || result=1 ;;
        claude-login)
            test "$status" -eq 1 && grep -Fq 'Claude authentication required' "$capture" || result=1 ;;
        native-update-policy)
            test "$status" -eq 1 && grep -Fq 'installation is fleet-managed' "$capture" || result=1 ;;
        observed) test "$status" -ne 124 && test "$status" -ne 137 || result=1 ;;
    esac
}
run 'native entry status' ok cxx native-entry status
run 'communicator status' observed cxx communicator status
for alias in cdx clx cgx ckx; do
    for action in --wrapper-version --status --doctor sync --update; do
        case "$alias:$action" in
            clx:sync|clx:--update) expected=claude-login ;;
            *:--status|*:--doctor) expected=observed ;;
            *) expected=ok ;;
        esac
        run "$alias $action" "$expected" "$alias" "$action"
    done
    run "$alias cron remove" ok "$alias" cron remove
    run "$alias cron install" ok "$alias" cron install
done
run 'host cron remove' ok cxx cron remove
run 'host cron install' ok cxx cron install
run 'host cron run' ok cxx cron run --minimal
run 'aggregate update reports Claude subscription state' claude-login cxx update --minimal
for engine in codex claude grok kimi; do
    run "native $engine version" ok cxx native "$engine" -- --version
    run "rtk $engine" observed cxx rtk status --engine "$engine" --json
done
for action in install setup; do
    run "Kimi preparation, $action" observed cxx native kimi -- "$action"
done
for action in update upgrade; do
    run "Kimi refuses native $action" native-update-policy cxx native kimi -- "$action"
done
exit "$result"
