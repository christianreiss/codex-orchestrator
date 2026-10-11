package agentbus

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestDaemonDeadlineBoundary(t *testing.T) {
	now := time.Date(2026, 10, 11, 12, 0, 0, 0, time.UTC)
	for _, value := range []string{"", now.Add(time.Second).Format(time.RFC3339)} {
		if deadlineExpired(value, now) {
			t.Fatalf("unexpected expiry for %q", value)
		}
	}
	for _, value := range []string{now.Format(time.RFC3339), now.Add(-time.Second).Format(time.RFC3339), "invalid"} {
		if !deadlineExpired(value, now) {
			t.Fatalf("missing expiry for %q", value)
		}
	}
}

func TestExpiredIdleDaemonExitsWithoutServer(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if err := rememberDaemonDeadline(daemonSettings{ExpiresAt: time.Now().Add(-time.Second).UTC().Format(time.RFC3339Nano)}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := runHostDaemon(ctx, "test", io.Discard, io.Discard); err != nil {
		t.Fatal(err)
	}
	if ctx.Err() != nil {
		t.Fatal("expired daemon waited for a server instead of stopping")
	}
}

func TestDaemonDeadlineSurvivesRestartAndIsNotAReceipt(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if daemonLocalExpired() {
		t.Fatal("permanent daemon expired")
	}
	settings := daemonSettings{Enabled: true, ExpiresAt: time.Now().Add(-time.Second).UTC().Format(time.RFC3339Nano)}
	if err := rememberDaemonDeadline(settings); err != nil {
		t.Fatal(err)
	}
	if !daemonLocalExpired() {
		t.Fatal("persisted expiry lost")
	}
	if err := rememberDaemonDeadline(daemonSettings{Enabled: true}); err != nil {
		t.Fatal(err)
	}
	if !daemonLocalExpired() {
		t.Fatal("reconnect cleared deadline")
	}
	dir, _ := daemonStateDir()
	if len(pendingDaemonReceipts(dir)) != 0 {
		t.Fatal("deadline counted as a receipt")
	}
	if err := os.WriteFile(filepath.Join(dir, "deadline.json"), []byte("broken"), 0600); err != nil {
		t.Fatal(err)
	}
	if !daemonLocalExpired() {
		t.Fatal("corrupt deadline failed open")
	}
}
