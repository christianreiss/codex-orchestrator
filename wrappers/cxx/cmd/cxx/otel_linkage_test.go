//go:build !cxx_otel

package main

// The link-time guard for the shipped artifact.
//
// "Tracing is off by default" has two halves. The runtime half is asserted in
// internal/observability/tracing. This is the build half, and it is the one
// that costs money: cxx is sha256-manifested and self-distributes, so every
// host in the fleet re-downloads the whole binary on each wrapper update.
// Linking the OpenTelemetry SDK unconditionally added ~7.2 MB (+79%) to that
// download for a feature nobody had switched on.
//
// This test runs against the *cmd/cxx test binary*, whose module graph is the
// released binary's graph, so it fails the moment any package in the tree
// imports go.opentelemetry.io outside the cxx_otel tag — including through a
// transitive dependency. The authoritative check remains
//
//	go build -o /tmp/cxx ./cmd/cxx && go version -m /tmp/cxx | grep opentelemetry
//
// but that one is not run by `make test`, and this one is.

import (
	"runtime/debug"
	"strings"
	"testing"
)

func TestDefaultBuildLinksNoOpenTelemetry(t *testing.T) {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		t.Fatal("no build info available; the module scan below would prove nothing")
	}
	// Without a module list the loop below passes for the wrong reason. cxx
	// always links at least go-toml and golang.org/x/term, so an empty list
	// means the guard, not the binary, is broken.
	if len(info.Deps) == 0 {
		t.Fatal("build info carries no module list; this guard would pass vacuously")
	}
	for _, dep := range info.Deps {
		if strings.HasPrefix(dep.Path, "go.opentelemetry.io/") {
			t.Fatalf("the default build links %s@%s; the OpenTelemetry SDK must stay behind -tags cxx_otel",
				dep.Path, dep.Version)
		}
	}
}
