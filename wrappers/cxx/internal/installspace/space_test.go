package installspace

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestBudgetsGroupByFilesystemAndReserve(t *testing.T) {
	for _, shared := range []bool{false, true} {
		t.Run(map[bool]string{true: "same", false: "separate"}[shared], func(t *testing.T) {
			ctx := WithProbe(context.Background(), func(path string) (Capacity, error) {
				dev := uint64(1)
				if path == "cache" && !shared {
					dev = 2
				}
				return Capacity{Device: dev, Bytes: 400 * MiB, Inodes: 100, InodesKnown: true}, nil
			})
			err := Check(ctx, "test", Need{"stage", 200 * MiB, 2}, Need{"cache", 200 * MiB, 2})
			if shared && !IsCapacity(err) {
				t.Fatalf("shared peak accepted: %v", err)
			}
			if !shared && err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestCleanupRechecksAndReports(t *testing.T) {
	for _, repaired := range []bool{true, false} {
		free := uint64(0)
		calls := 0
		ctx := WithProbe(context.Background(), func(string) (Capacity, error) { return Capacity{Bytes: free}, nil })
		err := Ensure(ctx, "test", func() error {
			calls++
			if repaired {
				free = 2 * Native
			}
			return nil
		}, Need{"stage", Native, 128})
		if calls != 1 {
			t.Fatalf("cleanup count %d", calls)
		}
		if repaired && err != nil {
			t.Fatal(err)
		}
		if !repaired && (err == nil || !strings.Contains(err.Error(), "cleanup: attempted")) {
			t.Fatalf("missing cleanup outcome: %v", err)
		}
	}
}

func TestCapacityFailureModes(t *testing.T) {
	for _, tc := range []struct {
		name     string
		cap      Capacity
		probeErr error
		want     string
	}{
		{"inodes", Capacity{Bytes: 4 * Native, Inodes: 0, InodesKnown: true}, nil, "inodes need 128"},
		{"unknown inodes", Capacity{Bytes: 4 * Native}, nil, ""},
		{"measurement", Capacity{}, syscall.EACCES, "cannot measure"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := WithProbe(context.Background(), func(string) (Capacity, error) { return tc.cap, tc.probeErr })
			err := Check(ctx, "test", Need{"stage", Native, 128})
			if tc.want == "" && err != nil {
				t.Fatal(err)
			}
			if tc.want != "" && (err == nil || !strings.Contains(err.Error(), tc.want)) {
				t.Fatalf("error %v", err)
			}
		})
	}
	ctx := WithProbe(context.Background(), func(string) (Capacity, error) { return Capacity{Bytes: ^uint64(0)}, nil })
	if err := Check(ctx, "overflow", Need{"stage", ^uint64(0), 1}, Need{"stage", 1, 1}); err == nil {
		t.Fatal("overflow accepted")
	}
}

func TestInspectMissingPathAndSymlink(t *testing.T) {
	root := t.TempDir()
	want, err := Inspect(root)
	if err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "link")
	if err := os.Symlink(root, link); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{filepath.Join(root, "not", "created"), filepath.Join(link, "not", "created")} {
		got, err := Inspect(path)
		if err != nil {
			t.Fatal(err)
		}
		if got.Device != want.Device {
			t.Fatalf("wrong filesystem: %+v", got)
		}
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("probe created path: %v", err)
		}
	}
}

func TestLockSerializesAndCancels(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	ctx, release, err := Lock(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	nested, done, err := Lock(ctx)
	if err != nil || nested == nil {
		t.Fatal(err)
	}
	done()
	wait, cancel := context.WithTimeout(context.Background(), 35*time.Millisecond)
	defer cancel()
	if _, done, err := Lock(wait); !errors.Is(err, context.DeadlineExceeded) {
		if done != nil {
			done()
		}
		t.Fatalf("contender: %v", err)
	}
	release()
	_, release, err = Lock(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	release()
}

func TestRuntimeNoSpaceClassification(t *testing.T) {
	err := WriteError("Claude", "stage", errors.New("npm ERR! code ENOSPC"))
	if !IsCapacity(err) || !strings.HasPrefix(err.Error(), "Claude: no space left") {
		t.Fatal(err)
	}
	if IsCapacity(errors.New("HTTP 503")) {
		t.Fatal("transport failure classified as capacity")
	}
}

func TestLockIsSharedWithOtherProcesses(t *testing.T) {
	if os.Getenv("INSTALLSPACE_LOCK_CHILD") == "1" {
		ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
		defer cancel()
		_, release, err := Lock(ctx)
		if release != nil {
			release()
		}
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("child bypassed parent's lock: %v", err)
		}
		return
	}
	t.Setenv("HOME", t.TempDir())
	_, release, err := Lock(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	cmd := exec.Command(os.Args[0], "-test.run=^TestLockIsSharedWithOtherProcesses$")
	cmd.Env = append(os.Environ(), "INSTALLSPACE_LOCK_CHILD=1")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("child lock check: %v: %s", err, out)
	}
}
