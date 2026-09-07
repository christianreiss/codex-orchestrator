package codex

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestHasActiveAuthChildUsesExistingLeaseOnly(t *testing.T) {
	home := filepath.Join(t.TempDir(), "absent-home")
	t.Setenv("CODEX_HOME", home)
	active, err := HasActiveAuthChild()
	if err != nil || active {
		t.Fatalf("missing lease = %v %v", active, err)
	}
	if _, err := os.Stat(home); !os.IsNotExist(err) {
		t.Fatal("inactive probe created auth state")
	}
	child, err := AcquireActiveChild()
	if err != nil {
		t.Fatal(err)
	}
	active, err = HasActiveAuthChild()
	if err != nil || !active {
		t.Fatalf("held lease = %v %v", active, err)
	}
	if err := child.Release(); err != nil {
		t.Fatal(err)
	}
	active, err = HasActiveAuthChild()
	if err != nil || active {
		t.Fatalf("stale lease file = %v %v", active, err)
	}
}

func TestCanonicalAcknowledgementBindsOnlyUnchangedAcceptedGeneration(t *testing.T) {
	t.Setenv("CODEX_HOME", t.TempDir())
	path, _ := AuthPath()
	native := []byte(`{"last_refresh":"2026-08-08T10:00:00Z","tokens":{"access_token":"native"}}`)
	if err := os.WriteFile(path, native, 0o600); err != nil {
		t.Fatal(err)
	}
	expected, _ := CurrentAuthGeneration()
	if known, err := IsCanonicalAuthGeneration(expected); err != nil || known {
		t.Fatalf("native bytes incorrectly bound: %v %v", known, err)
	}
	if acknowledged, err := AcknowledgeCanonicalAuthGeneration(context.Background(), expected); err != nil || !acknowledged {
		t.Fatalf("acknowledge = %v %v", acknowledged, err)
	}
	if known, err := IsCanonicalAuthGeneration(expected); err != nil || !known {
		t.Fatalf("accepted bytes unbound: %v %v", known, err)
	}
	newer := []byte(`{"last_refresh":"2026-08-08T11:00:00Z","tokens":{"access_token":"new-native"}}`)
	if err := os.WriteFile(path, newer, 0o600); err != nil {
		t.Fatal(err)
	}
	current, _ := CurrentAuthGeneration()
	if acknowledged, err := AcknowledgeCanonicalAuthGeneration(context.Background(), expected); err != nil || acknowledged {
		t.Fatalf("stale acknowledge = %v %v", acknowledged, err)
	}
	if known, err := IsCanonicalAuthGeneration(current); err != nil || known {
		t.Fatalf("new unsubmitted bytes bound: %v %v", known, err)
	}
	if _, err := MarkLogoutIntent(current); err != nil {
		t.Fatal(err)
	}
	if acknowledged, err := AcknowledgeCanonicalAuthGeneration(context.Background(), current); err != nil || acknowledged {
		t.Fatalf("logout acknowledged = %v %v", acknowledged, err)
	}
}

func TestSessionWriterCannotCreateMissingAuth(t *testing.T) {
	t.Setenv("CODEX_HOME", t.TempDir())
	got, err := WriteSessionAuthIfCurrent(context.Background(), json.RawMessage(`{"last_refresh":"2026-08-08T11:00:00Z","tokens":{"access_token":"canonical"}}`), AuthGeneration{})
	if err != nil || got.Written {
		t.Fatalf("missing session writer = %+v %v", got, err)
	}
	path, _ := AuthPath()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("session writer restored absent auth")
	}
}

func TestSessionAuthOperationsCancelBehindUploadLease(t *testing.T) {
	t.Setenv("CODEX_HOME", t.TempDir())
	payload := json.RawMessage(`{"last_refresh":"2026-08-08T11:00:00Z","tokens":{"access_token":"canonical"}}`)
	if err := WriteAuth(payload); err != nil {
		t.Fatal(err)
	}
	expected, _ := CurrentAuthGeneration()
	session, err := StartAuthSession(false)
	if err != nil {
		t.Fatal(err)
	}
	defer FinishAuthSession(session)
	lease, err := BeginAuthUpload(false)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Close()
	operations := map[string]func(context.Context) error{
		"upload": func(ctx context.Context) error {
			upload, err := BeginAuthUploadContext(ctx, false)
			if upload != nil {
				_ = upload.Close()
			}
			return err
		},
		"write": func(ctx context.Context) error {
			_, err := WriteSessionAuthIfCurrent(ctx, payload, expected)
			return err
		},
		"acknowledge": func(ctx context.Context) error {
			_, err := AcknowledgeCanonicalAuthGeneration(ctx, expected)
			return err
		},
		"logout check": func(ctx context.Context) error { _, err := LogoutIntentActiveContext(ctx); return err },
		"security update": func(ctx context.Context) error {
			secure := false
			return UpdateActiveAuthSessionSecurityContext(ctx, "valid", &secure)
		},
	}
	for name, operation := range operations {
		t.Run(name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
			defer cancel()
			started := time.Now()
			if err := operation(ctx); !errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("cancellation = %v", err)
			}
			if time.Since(started) > time.Second {
				t.Fatal("cancellation waited beyond its request budget")
			}
		})
	}
}
