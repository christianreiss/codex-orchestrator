package claude

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Spelled out rather than reused from the package so a change to the alias or
// the marker comment has to be made deliberately in both places.
const (
	testAliasLine    = "alias claude='clx'"
	testAliasComment = "# Added by clx"
)

// newHome points HOME at a fresh temp dir so EnsureShellAliases only ever
// touches files this test created.
func newHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	return home
}

func writeRC(t *testing.T, home, name, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(home, name), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func readRC(t *testing.T, home, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(home, name))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestEnsureShellAliasesSkipsMissingFiles(t *testing.T) {
	home := newHome(t)
	if err := EnsureShellAliases(); err != nil {
		t.Fatalf("absent rc files must be skipped: %v", err)
	}
	entries, err := os.ReadDir(home)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("home holds %v, want no rc file conjured up", entries)
	}
}

func TestEnsureShellAliasesAppendsCommentedAliasToEachRC(t *testing.T) {
	const existing = "export PATH=/usr/bin\n"
	home := newHome(t)
	writeRC(t, home, ".bashrc", existing)
	writeRC(t, home, ".zshrc", existing)

	if err := EnsureShellAliases(); err != nil {
		t.Fatalf("EnsureShellAliases: %v", err)
	}

	for _, rc := range []string{".bashrc", ".zshrc"} {
		got := readRC(t, home, rc)
		if !strings.HasPrefix(got, existing) {
			t.Fatalf("%s = %q, want the prior contents kept intact", rc, got)
		}
		if n := strings.Count(got, testAliasLine); n != 1 {
			t.Fatalf("%s = %q, want exactly 1 alias line, got %d", rc, got, n)
		}
		if !strings.Contains(got, testAliasComment+"\n"+testAliasLine+"\n") {
			t.Fatalf("%s = %q, want the alias preceded by %q", rc, got, testAliasComment)
		}
	}
}

func TestEnsureShellAliasesSecondCallChangesNothing(t *testing.T) {
	home := newHome(t)
	writeRC(t, home, ".bashrc", "# bash\n")
	writeRC(t, home, ".zshrc", "# zsh\n")

	if err := EnsureShellAliases(); err != nil {
		t.Fatalf("first call: %v", err)
	}
	afterFirst := map[string]string{
		".bashrc": readRC(t, home, ".bashrc"),
		".zshrc":  readRC(t, home, ".zshrc"),
	}
	if err := EnsureShellAliases(); err != nil {
		t.Fatalf("second call: %v", err)
	}
	for rc, want := range afterFirst {
		if got := readRC(t, home, rc); got != want {
			t.Fatalf("%s after second call = %q, want %q byte for byte", rc, got, want)
		}
	}
}

func TestEnsureShellAliasesLeavesHandWrittenAliasAlone(t *testing.T) {
	// An alias the user typed themselves carries no marker comment, and must
	// still suppress the append rather than earn a duplicate.
	const handWritten = "# bash\n" + testAliasLine + "\n"
	home := newHome(t)
	writeRC(t, home, ".bashrc", handWritten)
	writeRC(t, home, ".zshrc", handWritten)

	if err := EnsureShellAliases(); err != nil {
		t.Fatalf("EnsureShellAliases: %v", err)
	}
	for _, rc := range []string{".bashrc", ".zshrc"} {
		if got := readRC(t, home, rc); got != handWritten {
			t.Fatalf("%s = %q, want %q byte for byte", rc, got, handWritten)
		}
	}
}

func TestEnsureShellAliasesReportsUnreadableRCAndKeepsGoing(t *testing.T) {
	home := newHome(t)
	// A directory in the rc file's place opens fine but cannot be read.
	if err := os.Mkdir(filepath.Join(home, ".bashrc"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeRC(t, home, ".zshrc", "# zsh\n")

	err := EnsureShellAliases()
	if err == nil {
		t.Fatal("an unreadable .bashrc must be reported")
	}
	if !strings.Contains(err.Error(), ".bashrc") {
		t.Fatalf("error = %q, want it to name .bashrc", err.Error())
	}
	if strings.Contains(err.Error(), ".zshrc") {
		t.Fatalf("error = %q, want the healthy .zshrc left out of it", err.Error())
	}
	if got := readRC(t, home, ".zshrc"); !strings.Contains(got, testAliasLine) {
		t.Fatalf(".zshrc = %q, want it aliased even though .bashrc failed", got)
	}
}

func TestEnsureShellAliasesJoinsBothFailures(t *testing.T) {
	home := newHome(t)
	for _, rc := range []string{".bashrc", ".zshrc"} {
		if err := os.Mkdir(filepath.Join(home, rc), 0o755); err != nil {
			t.Fatal(err)
		}
	}

	err := EnsureShellAliases()
	if err == nil {
		t.Fatal("two unreadable rc files must be reported")
	}
	parts := strings.Split(err.Error(), "; ")
	if len(parts) != 2 {
		t.Fatalf("error = %q, want both failures joined by %q", err.Error(), "; ")
	}
	if !strings.HasPrefix(parts[0], ".bashrc: ") || !strings.HasPrefix(parts[1], ".zshrc: ") {
		t.Fatalf("error = %q, want each half prefixed with its own rc name", err.Error())
	}
}
