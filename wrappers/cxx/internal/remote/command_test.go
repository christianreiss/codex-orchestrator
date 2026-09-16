package remote

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

// allowPolicy switches the fleet gate on for tests that are about argument
// handling rather than about the gate itself.
func allowPolicy(t *testing.T) {
	t.Helper()
	previous := loadSignedConfig
	loadSignedConfig = enabledPolicy
	t.Cleanup(func() { loadSignedConfig = previous })
}

func run(t *testing.T, args ...string) (int, map[string]any, string) {
	t.Helper()
	var stdout, stderr bytes.Buffer
	code := RunCommand(args, strings.NewReader(""), &stdout, &stderr, "test")
	payload := map[string]any{}
	if body := strings.TrimSpace(stdout.String()); body != "" {
		if err := json.Unmarshal([]byte(body), &payload); err != nil {
			t.Fatalf("stdout is not one JSON object: %q (%v)", stdout.String(), err)
		}
	}
	return code, payload, stderr.String()
}

func TestNoArgumentsIsAUsageError(t *testing.T) {
	allowPolicy(t)
	if code, _, stderr := run(t); code != ExitUsage || !strings.Contains(stderr, "Usage:") {
		t.Fatalf("exit = %d, stderr = %q", code, stderr)
	}
}

func TestUnknownVerbFailsClosed(t *testing.T) {
	allowPolicy(t)
	code, _, stderr := run(t, "sudo-everything", "--host", "build01")
	if code != ExitUsage {
		t.Fatalf("exit = %d, want %d", code, ExitUsage)
	}
	if !strings.Contains(stderr, "unknown command") {
		t.Fatalf("stderr = %q", stderr)
	}
}

func TestHelpIsFreeOfThePolicyGate(t *testing.T) {
	// Deliberately no allowPolicy: reading the help must work on a machine with
	// no signed configuration at all, or an operator cannot find out why the
	// rest refuses.
	previous := loadSignedConfig
	loadSignedConfig = disabledPolicy
	t.Cleanup(func() { loadSignedConfig = previous })
	for _, arg := range []string{"help", "--help", "-h"} {
		var stdout, stderr bytes.Buffer
		if code := RunCommand([]string{arg}, strings.NewReader(""), &stdout, &stderr, "test"); code != ExitOK {
			t.Fatalf("%s exit = %d", arg, code)
		}
		if !strings.Contains(stdout.String(), "cxx remote") {
			t.Fatalf("%s printed no help: %q", arg, stdout.String())
		}
	}
}

func TestEveryTargetVerbRequiresAHost(t *testing.T) {
	allowPolicy(t)
	for _, args := range [][]string{
		{"info"},
		{"exec", "--", "true"},
		{"read", "--job", "a"},
		{"write", "--job", "a"},
		{"wait", "--job", "a"},
		{"signal", "--job", "a"},
		{"ps"},
		{"rm", "--job", "a"},
		{"get", "--path", "/etc/hostname"},
		{"put", "--path", "/tmp/x"},
		{"push", "src", "dst"},
		{"pull", "src", "dst"},
		{"down"},
	} {
		code, payload, _ := run(t, args...)
		if code != ExitUsage {
			t.Fatalf("%v exit = %d, want %d", args, code, ExitUsage)
		}
		if payload["code"] != CodeUsage {
			t.Fatalf("%v code = %v", args, payload["code"])
		}
	}
}

// TestExecRequiresTheSeparator is the guard against a mistyped flag silently
// becoming the command that runs on somebody else's machine.
func TestExecRequiresTheSeparator(t *testing.T) {
	allowPolicy(t)
	code, payload, _ := run(t, "exec", "--host", "build01", "make")
	if code != ExitUsage {
		t.Fatalf("exit = %d, want %d", code, ExitUsage)
	}
	if !strings.Contains(payload["message"].(string), "'--'") {
		t.Fatalf("message = %v", payload["message"])
	}
}

func TestExecKeepsArgvVerbatimAfterTheSeparator(t *testing.T) {
	allowPolicy(t)
	// Every token here would be eaten by the flag parser if the split were not
	// done before parsing: a lone -x, a --host that must not rebind the target,
	// and a bare --.
	code, payload, _ := run(t, "exec", "--host", "build01", "--", "sh", "-x", "--host", "--")
	if code != ExitError || payload["code"] != CodeNotImplemented {
		t.Fatalf("exit = %d, payload = %#v", code, payload)
	}
}

func TestExecValidatesItsOwnArguments(t *testing.T) {
	allowPolicy(t)
	for _, tc := range []struct {
		name string
		args []string
	}{
		{"job id with a separator", []string{"exec", "--host", "h", "--job", "a/b", "--", "true"}},
		{"env without a value", []string{"exec", "--host", "h", "--env", "JUSTAKEY", "--", "true"}},
		{"settle beyond the ceiling", []string{"exec", "--host", "h", "--settle", "30s", "--", "true"}},
		{"unparsable size", []string{"exec", "--host", "h", "--max-log", "lots", "--", "true"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if code, _, _ := run(t, tc.args...); code != ExitUsage {
				t.Fatalf("exit = %d, want %d", code, ExitUsage)
			}
		})
	}
}

func TestReadAndSignalRejectNonsenseBeforeTouchingTheNetwork(t *testing.T) {
	allowPolicy(t)
	for _, args := range [][]string{
		{"read", "--host", "h", "--job", "a", "--stream", "sideways"},
		{"read", "--host", "h", "--job", "a", "--from", "-1"},
		{"signal", "--host", "h", "--job", "a", "--signal", "BOOM"},
		{"put", "--host", "h", "--path", "/tmp/x", "--mode", "not-octal"},
		{"push", "--host", "h", "only-one-directory"},
	} {
		if code, _, _ := run(t, args...); code != ExitUsage {
			t.Fatalf("%v exit = %d, want %d", args, code, ExitUsage)
		}
	}
}

// TestSignalAcceptsTheSIGPrefix exists because both spellings are in every
// operator's fingers and rejecting one is a pointless failure.
func TestSignalAcceptsTheSIGPrefix(t *testing.T) {
	allowPolicy(t)
	code, payload, _ := run(t, "signal", "--host", "h", "--job", "a", "--signal", "sigterm")
	if code != ExitError || payload["code"] != CodeNotImplemented {
		t.Fatalf("exit = %d, payload = %#v", code, payload)
	}
}

func TestByteSizeAcceptsTheSpellingsPeopleUse(t *testing.T) {
	for _, tc := range []struct {
		in   string
		want int64
	}{
		{"1024", 1024},
		{"64MiB", 64 << 20},
		{"64M", 64 << 20},
		{"4mb", 4 << 20},
		{"512k", 512 << 10},
		{"2GiB", 2 << 30},
		{"0", 0},
	} {
		var got byteSize
		if err := got.Set(tc.in); err != nil || int64(got) != tc.want {
			t.Fatalf("Set(%q) = %d (%v), want %d", tc.in, int64(got), err, tc.want)
		}
	}
	for _, bad := range []string{"", "lots", "-1", "12x", "MiB"} {
		var got byteSize
		if err := got.Set(bad); err == nil {
			t.Fatalf("Set(%q) was accepted as %d", bad, int64(got))
		}
	}
}

func TestSplitArgvFindsOnlyTheFirstSeparator(t *testing.T) {
	before, argv, found := splitArgv([]string{"--host", "h", "--", "sh", "-c", "--", "x"})
	if !found {
		t.Fatal("separator not found")
	}
	if strings.Join(before, " ") != "--host h" {
		t.Fatalf("before = %v", before)
	}
	if strings.Join(argv, " ") != "sh -c -- x" {
		t.Fatalf("argv = %v", argv)
	}
	if _, _, found := splitArgv([]string{"--host", "h"}); found {
		t.Fatal("separator reported where there is none")
	}
}
