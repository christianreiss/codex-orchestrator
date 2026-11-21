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
