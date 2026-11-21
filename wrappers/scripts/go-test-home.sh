#!/bin/sh
# go test -exec invokes this once for each package test process. Keep build
# caches reusable while giving product code and helper processes a fresh home.
set -eu

lab=$(mktemp -d "${TMPDIR:-/tmp}/cxx-test.XXXXXXXX")
trap 'rm -rf "$lab"' 0
mkdir -m 700 "$lab/home" "$lab/run"
: "${GOCACHE:=$(go env GOCACHE)}" "${GOPATH:=$(go env GOPATH)}" "${GOMODCACHE:=$(go env GOMODCACHE)}"
export GOCACHE GOPATH GOMODCACHE
unset XDG_CONFIG_HOME XDG_CACHE_HOME XDG_DATA_HOME XDG_STATE_HOME
unset CODEX_HOME CLAUDE_CONFIG_DIR GROK_HOME KIMI_CODE_HOME CXX_GROK_BASE_HOME CXX_KIMI_BASE_HOME
unset CDX_CONFIG_PATH CLX_CONFIG_PATH CGX_CONFIG_PATH CKX_CONFIG_PATH GROK_CONFIG GROK_CONFIG_PATH
unset CLAUDE_CODE_MANAGED_SETTINGS_PATH CXX_AGENT_PORTAL_SOCKET CXX_CODEX_SOCKET CXX_GROK_SOCKET
env HOME="$lab/home" XDG_RUNTIME_DIR="$lab/run" "$@"
