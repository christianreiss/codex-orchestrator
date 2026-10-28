package cron

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/buildinfo"
)

// Feedback 3e2df8d1: background maintenance of a development build asked its
// own binary to install the shared service, which repointed the user's unit at
// a scratch path. The maintenance ensure is skipped, with a note, for such a
// build; a release build still repairs its worker.
func TestMaintenanceServiceEnsureSkipsDevelopmentBuild(t *testing.T) {
	dir := t.TempDir()
	marker := filepath.Join(dir, "ran")
	canonical := filepath.Join(dir, "cxx")
	script := "#!/bin/sh\necho \"$@\" > '" + marker + "'\n"
	if err := os.WriteFile(canonical, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	old := buildinfo.Version
	t.Cleanup(func() { buildinfo.Version = old })

	buildinfo.Version = "dev"
	var note bytes.Buffer
	if err := defaultEnsureAgentService(context.Background(), canonical, io.Discard, &note); err != nil {
		t.Fatalf("development build ensure: %v", err)
	}
	if _, err := os.Stat(marker); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("development build ran agent service install: %v", err)
	}
	if !strings.Contains(note.String(), "development build") {
		t.Fatalf("skip was silent: %q", note.String())
	}

	buildinfo.Version = "0.9.142"
	if err := defaultEnsureAgentService(context.Background(), canonical, io.Discard, io.Discard); err != nil {
		t.Fatalf("release ensure: %v", err)
	}
	if got, err := os.ReadFile(marker); err != nil || strings.TrimSpace(string(got)) != "agent service install" {
		t.Fatalf("release build did not repair its worker: %q %v", got, err)
	}
}
