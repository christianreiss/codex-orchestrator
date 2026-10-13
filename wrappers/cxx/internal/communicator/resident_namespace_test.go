package communicator

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
	"github.com/google/uuid"
)

func TestResidentNamespaceLiveDiscoveryAndExclusion(t *testing.T) {
	root, err := os.MkdirTemp("", "cc-ns-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(root)
	t.Setenv("XDG_RUNTIME_DIR", root)
	base := "https://" + uuid.NewString() + ".example"
	socket, err := socketPath(base)
	if err != nil {
		t.Fatal(err)
	}
	dir, _, err := residentCoordination(base)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	release, err := claimResidentNamespace(base, socket)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	if second, err := claimResidentNamespace(base, socket); err == nil {
		second()
		t.Fatal("duplicate namespace owner elected")
	}
	if _, err := discoverResidentOwner(context.Background(), base); err == nil {
		t.Fatal("occupied unavailable owner treated as free")
	}
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	if err := os.Chmod(socket, 0600); err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"owner_instance_id": processInstance, "pid": os.Getpid(), "runtime_protocol": 1})
	})}
	go server.Serve(listener)
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	got, err := discoverResidentOwner(ctx, base)
	if err != nil || got != socket {
		t.Fatalf("discovery: %s %v", got, err)
	}
	if err := os.Chmod(socket, 0666); err != nil {
		t.Fatal(err)
	}
	if _, err := discoverResidentOwner(ctx, base); err == nil {
		t.Fatal("unsafe socket accepted")
	}
}

func TestResidentNamespaceStaleRecordRequiresExistingSafeLock(t *testing.T) {
	root, err := os.MkdirTemp("", "cc-stale-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(root)
	t.Setenv("XDG_RUNTIME_DIR", root)
	base := "https://" + uuid.NewString() + ".example"
	socket, err := socketPath(base)
	if err != nil {
		t.Fatal(err)
	}
	dir, _, err := residentCoordination(base)
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	release, err := claimResidentNamespace(base, socket)
	if err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(filepath.Join(dir, "owner.json"))
	if err != nil {
		t.Fatal(err)
	}
	release()
	if err := os.WriteFile(filepath.Join(dir, "owner.json"), body, 0600); err != nil {
		t.Fatal(err)
	}
	got, err := discoverResidentOwner(context.Background(), base)
	if err != nil || got != "" {
		t.Fatalf("stale owner not free: %s %v", got, err)
	}
	if err := os.Remove(filepath.Join(dir, "owner.lock")); err != nil {
		t.Fatal(err)
	}
	if _, err := discoverResidentOwner(context.Background(), base); err == nil {
		t.Fatal("missing lock created during discovery")
	}
	if _, err := os.Stat(filepath.Join(dir, "owner.lock")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("discovery mutated missing lock")
	}
	if err := os.Symlink(filepath.Join(root, "unrelated"), filepath.Join(dir, "owner.lock")); err != nil {
		t.Fatal(err)
	}
	if _, err := discoverResidentOwner(context.Background(), base); err == nil {
		t.Fatal("symlink lock accepted")
	}
}

func TestResidentNamespacesKeepExplicitRootsIndependent(t *testing.T) {
	base := "https://" + uuid.NewString() + ".example"
	firstRoot := t.TempDir()
	secondRoot := t.TempDir()
	os.Chmod(firstRoot, 0700)
	os.Chmod(secondRoot, 0700)
	// Long roots deliberately use the audited hashed fallback path.
	t.Setenv("XDG_RUNTIME_DIR", firstRoot)
	first, err := socketPath(base)
	if err != nil {
		t.Fatal(err)
	}
	firstDir, _, _ := residentCoordination(base)
	defer os.RemoveAll(firstDir)
	release, err := claimResidentNamespace(base, first)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	t.Setenv("XDG_RUNTIME_DIR", secondRoot)
	second, err := socketPath(base)
	if err != nil {
		t.Fatal(err)
	}
	secondDir, _, _ := residentCoordination(base)
	defer os.RemoveAll(secondDir)
	if first == second || firstDir == secondDir {
		t.Fatal("explicit namespaces collapsed")
	}
	lock, err := ipc.TryAcquireExclusivePath(filepath.Join(filepath.Dir(second), "owner.lock"))
	if err != nil {
		t.Fatal(err)
	}
	lock.Release()
	other, err := claimResidentNamespace(base, second)
	if err != nil {
		t.Fatal(err)
	}
	other()
}
