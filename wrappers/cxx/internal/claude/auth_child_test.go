package claude

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestAuthChildSharedLeaseBlocksWriterUntilClosed(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	shared, err := acquireAuthChildShared()
	if err != nil {
		t.Fatal(err)
	}
	writer, err := tryAcquireAuthChildWriter()
	if writer != nil || !errors.Is(err, ErrAuthChildActive) {
		t.Fatalf("writer during shared lease = (%v,%v), want ErrAuthChildActive", writer, err)
	}
	if err := shared.Close(); err != nil {
		t.Fatal(err)
	}
	writer, err = tryAcquireAuthChildWriter()
	if err != nil {
		t.Fatalf("writer after shared lease released: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestAuthChildSharedLeasesDoNotSerializeChildren(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	first, err := acquireAuthChildShared()
	if err != nil {
		t.Fatal(err)
	}
	second, err := acquireAuthChildShared()
	if err != nil {
		t.Fatalf("second concurrent shared lease: %v", err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	// The surviving peer still owns the credential path.
	if writer, err := tryAcquireAuthChildWriter(); writer != nil || !errors.Is(err, ErrAuthChildActive) {
		t.Fatalf("writer with one shared peer left = (%v,%v), want ErrAuthChildActive", writer, err)
	}
	if err := second.Close(); err != nil {
		t.Fatal(err)
	}
	writer, err := tryAcquireAuthChildWriter()
	if err != nil {
		t.Fatalf("writer after both shared leases released: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestAuthChildLeaseCloseIsSafeOnNilAndRepeated(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	var absent *authChildLease
	if err := absent.Close(); err != nil {
		t.Fatalf("nil lease Close: %v", err)
	}
	lease, err := acquireAuthChildShared()
	if err != nil {
		t.Fatal(err)
	}
	if err := lease.Close(); err != nil {
		t.Fatal(err)
	}
	if err := lease.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}
}

func TestDuplicateLeaseFileRejectsNilFile(t *testing.T) {
	dup, err := duplicateLeaseFile(nil, "clx-auth-active-child")
	if dup != nil {
		t.Fatalf("duplicateLeaseFile(nil) file = %v, want nil", dup)
	}
	if err == nil || !strings.Contains(err.Error(), "clx-auth-active-child") {
		t.Fatalf("duplicateLeaseFile(nil) error = %v, want one naming the lease", err)
	}
}

func TestAttachAuthLeaseFilesDuplicatesEachLease(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	session, err := StartAuthSession(false)
	if err != nil {
		t.Fatal(err)
	}
	child, err := acquireAuthChildShared()
	if err != nil {
		t.Fatal(err)
	}

	// A pre-existing entry must survive: the leases are appended to whatever
	// descriptors the caller already passes to the child.
	existing, err := os.Create(filepath.Join(t.TempDir(), "pre-existing"))
	if err != nil {
		t.Fatal(err)
	}
	cmd := &exec.Cmd{ExtraFiles: []*os.File{existing}}
	closeExtras, err := attachAuthLeaseFiles(cmd, session, child)
	if err != nil {
		t.Fatal(err)
	}
	if len(cmd.ExtraFiles) != 3 {
		t.Fatalf("ExtraFiles = %d entries, want 3", len(cmd.ExtraFiles))
	}
	names := []string{cmd.ExtraFiles[1].Name(), cmd.ExtraFiles[2].Name()}
	want := []string{"clx-auth-session-child", "clx-auth-active-child"}
	if names[0] != want[0] || names[1] != want[1] {
		t.Fatalf("appended lease names = %v, want %v", names, want)
	}
	if cmd.ExtraFiles[2].Fd() == child.f.Fd() {
		t.Fatal("child lease was handed over instead of duplicated")
	}

	closeExtras()
	for i, f := range cmd.ExtraFiles[1:] {
		if _, err := f.Stat(); !errors.Is(err, os.ErrClosed) {
			t.Fatalf("duplicate %d after closer = %v, want closed", i, err)
		}
	}
	if _, err := existing.Stat(); err != nil {
		t.Fatalf("pre-existing ExtraFiles entry was closed: %v", err)
	}
	// Releasing the parent's duplicates leaves the leases themselves held; only
	// the original owner ends them.
	if writer, err := tryAcquireAuthChildWriter(); writer != nil || !errors.Is(err, ErrAuthChildActive) {
		t.Fatalf("writer after duplicates were released = (%v,%v), want ErrAuthChildActive", writer, err)
	}
	if err := child.Close(); err != nil {
		t.Fatalf("child Close after duplication: %v", err)
	}
	if err := session.Close(); err != nil {
		t.Fatalf("session Close after duplication: %v", err)
	}
	writer, err := tryAcquireAuthChildWriter()
	if err != nil {
		t.Fatalf("writer after the child lease was released: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := existing.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestAttachAuthLeaseFilesWithoutSessionAttachesChildOnly(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	child, err := acquireAuthChildShared()
	if err != nil {
		t.Fatal(err)
	}
	defer child.Close() //nolint:errcheck
	cmd := &exec.Cmd{}
	closeExtras, err := attachAuthLeaseFiles(cmd, nil, child)
	if err != nil {
		t.Fatal(err)
	}
	defer closeExtras()
	if len(cmd.ExtraFiles) != 1 || cmd.ExtraFiles[0].Name() != "clx-auth-active-child" {
		t.Fatalf("ExtraFiles = %v, want only the child lease", cmd.ExtraFiles)
	}
}

func TestAttachAuthLeaseFilesRejectsClosedLeases(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	t.Run("closed_session", func(t *testing.T) {
		session, err := StartAuthSession(false)
		if err != nil {
			t.Fatal(err)
		}
		if err := session.Close(); err != nil {
			t.Fatal(err)
		}
		child, err := acquireAuthChildShared()
		if err != nil {
			t.Fatal(err)
		}
		defer child.Close() //nolint:errcheck
		cmd := &exec.Cmd{}
		closeExtras, err := attachAuthLeaseFiles(cmd, session, child)
		if err == nil || !strings.Contains(err.Error(), "already closed before child start") {
			t.Fatalf("attach with closed session error = %v, want a closed-session refusal", err)
		}
		if len(cmd.ExtraFiles) != 0 {
			t.Fatalf("ExtraFiles = %v, want none on failure", cmd.ExtraFiles)
		}
		closeExtras()
	})

	t.Run("closed_child", func(t *testing.T) {
		session, err := StartAuthSession(false)
		if err != nil {
			t.Fatal(err)
		}
		defer session.Close() //nolint:errcheck
		child, err := acquireAuthChildShared()
		if err != nil {
			t.Fatal(err)
		}
		if err := child.Close(); err != nil {
			t.Fatal(err)
		}
		cmd := &exec.Cmd{}
		closeExtras, err := attachAuthLeaseFiles(cmd, session, child)
		if err == nil || !strings.Contains(err.Error(), "clx-auth-active-child") {
			t.Fatalf("attach with closed child error = %v, want one naming the child lease", err)
		}
		// The session duplicate taken before the failure is never handed to the
		// child, so an aborted start leaks no lease descriptor.
		if len(cmd.ExtraFiles) != 0 {
			t.Fatalf("ExtraFiles = %v, want none on failure", cmd.ExtraFiles)
		}
		closeExtras()
	})
}

// expectAuthChildWriterAvailable asserts the shared lease taken for the help
// child was released again once RunHelpPassthrough returned.
func expectAuthChildWriterAvailable(t *testing.T) {
	t.Helper()
	writer, err := tryAcquireAuthChildWriter()
	if err != nil {
		t.Fatalf("writer after help passthrough returned: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestRunHelpPassthroughRejectsEmptyArgv(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	code, err := RunHelpPassthrough(context.Background(), "/bin/sh", nil, nil, nil, io.Discard, io.Discard, nil)
	if err == nil {
		t.Fatalf("empty argv = (%d,nil), want an error", code)
	}
	expectAuthChildWriterAvailable(t)
}

func TestRunHelpPassthroughReportsUnstartableBinaryAs127(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	missing := filepath.Join(t.TempDir(), "claude")
	code, err := RunHelpPassthrough(context.Background(), missing, []string{"claude", "--help"}, nil, nil, io.Discard, io.Discard, nil)
	if code != 127 || err == nil {
		t.Fatalf("unstartable help binary = (%d,%v), want (127, error)", code, err)
	}
	expectAuthChildWriterAvailable(t)
}

func TestRunHelpPassthroughReturnsChildExitStatus(t *testing.T) {
	for _, tc := range []struct {
		name   string
		script string
		want   int
	}{
		{name: "clean exit", script: "exit 0", want: 0},
		{name: "child failure", script: "exit 7", want: 7},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("HOME", t.TempDir())
			code, err := RunHelpPassthrough(
				context.Background(),
				"/bin/sh",
				[]string{"claude", "-c", tc.script},
				nil, nil, io.Discard, io.Discard, nil,
			)
			if code != tc.want || err != nil {
				t.Fatalf("help passthrough = (%d,%v), want (%d,nil)", code, err, tc.want)
			}
			expectAuthChildWriterAvailable(t)
		})
	}
}

func TestRunHelpPassthroughForwardsChildOutput(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	var stdout, stderr bytes.Buffer
	code, err := RunHelpPassthrough(
		context.Background(),
		"/bin/sh",
		[]string{"claude", "-c", "printf usage; printf deprecation 1>&2"},
		nil, nil, &stdout, &stderr, nil,
	)
	if code != 0 || err != nil {
		t.Fatalf("help passthrough = (%d,%v), want (0,nil)", code, err)
	}
	if stdout.String() != "usage" || stderr.String() != "deprecation" {
		t.Fatalf("forwarded streams = (%q,%q), want (%q,%q)", stdout.String(), stderr.String(), "usage", "deprecation")
	}
}
