package claude

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"
)

func TestAuthContextCancelsContendedCredentialTransactions(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	payload := json.RawMessage(`{"last_refresh":"2026-09-07T10:00:00Z","claudeAiOauth":{"accessToken":"fixture"}}`)
	if err := WriteAuth(payload); err != nil {
		t.Fatal(err)
	}
	snap, _, release, err := BeginChangedAuthUploadState()
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	for name, operation := range map[string]func(context.Context) error{
		"snapshot":          func(ctx context.Context) error { _, err := ReadAuthSnapshotContext(ctx, false); return err },
		"retrieve snapshot": func(ctx context.Context) error { _, err := ReadAuthForRetrieveSnapshotContext(ctx); return err },
		"upload": func(ctx context.Context) error {
			_, _, release, err := BeginChangedAuthUploadStateContext(ctx)
			if release != nil {
				release()
			}
			return err
		},
		"session start": func(ctx context.Context) error {
			session, err := StartAuthSessionContext(ctx, false)
			if session != nil {
				_ = session.Close()
			}
			return err
		},
		"writeback": func(ctx context.Context) error {
			_, _, err := WriteSessionAuthIfCurrentWithDigest(ctx, payload, strings.Repeat("a", 64), "verified", snap.Generation)
			return err
		},
		"acknowledgement": func(ctx context.Context) error {
			_, err := AcknowledgeAuthGeneration(ctx, snap.Generation, strings.Repeat("a", 64))
			return err
		},
	} {
		t.Run(name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
			defer cancel()
			started := time.Now()
			if err := operation(ctx); !errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("contended operation = %v", err)
			}
			if time.Since(started) > time.Second {
				t.Fatal("credential lock ignored caller deadline")
			}
		})
	}
}

func TestIndependentNativeCredentialsCannotBypassExplicitAccountLogout(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	payload := json.RawMessage(`{"last_refresh":"2026-09-07T10:00:00Z","claudeAiOauth":{"accessToken":"logged-out"}}`)
	if err := WriteAuth(payload); err != nil {
		t.Fatal(err)
	}
	path, _ := AuthPath()
	raw := []byte(`{"claudeAiOauth":{"accessToken":"logged-out"},"mcpOAuth":{"local":"private"}}`)
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	snap, _ := ReadAuthSnapshot(false)
	if _, err := RecordDeferredExplicitLogout(snap.Generation); err != nil {
		t.Fatal(err)
	}
	if applied, err := WriteVerifiedServerAuthIfCurrentWithDigest(payload, strings.Repeat("a", 64), "verified", snap.Generation); err != nil || applied {
		t.Fatalf("same account restored through extra-field mismatch: %v %v", applied, err)
	}
	// A native MCP-only change is not a fresh login and cannot upload the
	// account whose logout marker still applies.
	raw = []byte(`{"claudeAiOauth":{"accessToken":"logged-out"},"mcpOAuth":{"local":"new-private"}}`)
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	current, err := ReadAuthForRetrieveSnapshot()
	if err != nil || current.Usable {
		t.Fatalf("MCP edit bypassed logout: usable=%v err=%v", current.Usable, err)
	}
}
