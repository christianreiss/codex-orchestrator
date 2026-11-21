#!/bin/sh
set -eu
export HOME=/work/home GOCOVERDIR=/evidence
mkdir -p "$HOME" /work/bin /work/project
for command in cxx cdx clx cgx ckx; do ln -s /review-cxx /work/bin/"$command"; done
export PATH=/work/bin:/usr/local/bin:/usr/bin:/bin
cd /work/project
check() {
    label="$1"; shift
    if timeout 8 "$@" </dev/null >/work/command-output 2>&1; then result=0; else result=$?; fi
    printf '%s\t%s\n' "$label" "$result"
    case "$label" in
        'cdx synchronise without config'|'clx synchronise without config'|'cdx update without config'|'clx update without config') expected=2 ;;
        'daemon status'|'watchdog status'|'project upload without config'|'transfer missing settings') expected=1 ;;
        *'without config'|'native-entry install without assignment') expected=1 ;;
        *) expected=0 ;;
    esac
    test "$result" -eq "$expected"
}
for persona in cdx clx cgx ckx; do
    check "$persona wrapper version" "$persona" --wrapper-version
    check "$persona wrapper help" "$persona" --wrapper-help
    check "$persona status without config" "$persona" --status
    check "$persona doctor without config" "$persona" --doctor
    check "$persona agent help" "$persona" agent --help
    check "$persona transfer help" "$persona" transfer --help
done
for engine in codex claude grok kimi; do
    check "explicit $engine version" cxx "$engine" --wrapper-version
done
check 'cxx help' cxx --help
check 'native-entry status' cxx native-entry status
check 'native-entry install without assignment' cxx native-entry install
check 'native-entry status after refused install' cxx native-entry status
check 'native-entry removal from private home' cxx native-entry remove
check 'RTK status without policy' cxx rtk status --json
check 'transfer help' cxx transfer --help
check 'project file command help' cxx project --help
check 'agent doctor without session' cxx agent doctor

for persona in cdx clx cgx ckx; do
    check "$persona synchronise without config" "$persona" sync
    check "$persona named status without config" "$persona" status
    check "$persona update without config" "$persona" update
    check "$persona account-neutral diagnostics without config" "$persona" -4 --verbose --allow-concurrent-sync doctor
done
check 'local session status' cxx agent status
check 'service status' cxx agent service status
check 'daemon status' cxx daemon status
check 'watchdog status' cxx watchdog status
check 'Claude statusline without sample' cxx claude-quota-statusline
check 'project upload without config' cxx project file put fixture /work/absent --engine kimi --mime-type text/plain
check 'transfer missing settings' cxx transfer get 1 --engine codex --overwrite --output /work/download
check 'project help via named persona' ckx project --help

# A local agent socket belongs to one managed native launch. An ordinary
# shell should identify that boundary before attempting delivery or waiting.
unbound() {
    label=$1; shift
    if timeout 8 "$@" </dev/null >/work/command-output 2>&1; then result=0; else result=$?; fi
    printf '%s\t%s\n' "$label" "$result"
    test "$result" -eq 1
    grep -Fq 'only inside a managed cdx/clx/cgx/ckx lifecycle' /work/command-output
}
conversation=00000000-0000-4000-a000-000000000123
unbound 'local MCP outside a session' cxx agent mcp
unbound 'automatic MCP outside a session' cxx agent mcp --auto
unbound 'read a message outside a session' cxx agent message "$conversation"
unbound 'wait outside a session' cxx agent wait --conversation "$conversation" --seconds 0
unbound 'cancel outside a session' cxx agent cancel --conversation "$conversation"
unbound 'listen outside a session' cxx agent listen

# Podman gives the offline client its own /tmp and cgroup. The admission
# check reads real kernel counters and releases the reservation after exit.
check 'cooperative memory admission' cxx workload run --memory 1MiB --reserve 1MiB --wait 0s -- /bin/sh -c 'printf "admitted\n"'
grep -Fq 'admitted' /work/command-output
check 'cooperative workload status' cxx workload status
grep -Fq 'jobs=0 reserved_bytes=0' /work/command-output
check 'hold cooperative admission' cxx workload hold
check 'resume cooperative admission' cxx workload resume

# Exercise the actual hook, broker and admission boundaries with an empty
# synthetic home. Native hooks receive JSON over stdin, just as on a host.
observe() {
    label="$1"; expected="$2"; message="$3"; input="$4"; shift 4
    result=0
    printf '%s\n' "$input" | timeout 8 "$@" >/work/command-output 2>&1 || result=$?
    printf '%s\t%s\n' "$label" "$result"
    test "$result" -eq "$expected"
    if test -n "$message"; then grep -Fq -- "$message" /work/command-output; fi
}
observe 'Grok explicit config and wrapper version' 0 'cgx ' '' cgx --config /work/missing --wrapper-version
observe 'Kimi requires a prompt to execute' 2 '--execute requires a prompt' '' ckx --execute
observe 'Kimi launch requires assignment' 1 'read config' '' ckx run
observe 'Kimi uninstall requires assignment' 1 'read config' '' ckx --uninstall
observe 'Grok accessor requires its private broker' 1 'Grok auth broker missing' '' cxx grok-auth
observe 'Claude channel requires a managed Claude lifecycle' 1 'only inside a managed Claude lifecycle' '' cxx agent mcp --channel
observe 'ordinary activity hint outside managed session' 0 '' '{"session_id":"synthetic","hook_event_name":"SessionStart"}' cxx agent activity-event
observe 'completed end event leaves watchdog quiet' 0 '' '{"hook_event_name":"SessionEnd","reason":"completed"}' cxx agent watchdog-event
observe 'native session hook requires an ID' 1 'native session identity missing' '{}' cxx agent native-session
observe 'relay worker requires explicit foreground mode' 1 '--foreground is required' '' cxx agent worker

# This container has neither a system daemon nor a login-manager socket.
# The system-wide management requests must surface their privilege requirement.
for action in start stop install uninstall apply-update; do
    observe "unprivileged daemon $action" 1 'requires root' '' cxx daemon "$action"
done
