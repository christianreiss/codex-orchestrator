package nativeargs

import "testing"

func TestMaintenanceCommandAndValueBoundaries(t *testing.T) {
	for _, tc := range []struct {
		engine           string
		args             []string
		command, service string
	}{
		{"codex", []string{"migrate-nfs-db", "--staging-dir", "login"}, "migrate-nfs-db", "migrate-nfs-db"},
		{"codex", []string{"--staging-dir", "login"}, "", ""},
		{"codex", []string{"--staging-dir", "--remote"}, "", ""},
		{"codex", []string{"--model", "migrate-nfs-db"}, "", ""},
		{"codex", []string{"--image", "migrate-nfs-db", "login"}, "", ""},
		{"codex", []string{"update"}, "update", ""},
		{"codex", []string{"doctor"}, "doctor", ""},
		{"grok", []string{"--add-dir", "login"}, "", ""},
		{"grok", []string{"--add-dir", "worker"}, "", ""},
		{"grok", []string{"--add-dir", "--leader-socket"}, "", ""},
		{"grok", []string{"--add-dir=login", "worker", "start"}, "worker", "worker"},
		{"grok", []string{"--debug", "worker", "status"}, "worker", "worker"},
		{"grok", []string{"--", "worker"}, "", ""},
	} {
		if got, _ := Command(tc.engine, tc.args); got != tc.command {
			t.Errorf("%s %q command %q want %q", tc.engine, tc.args, got, tc.command)
		}
		if got := UnsupportedService(tc.engine, tc.args); got != tc.service {
			t.Errorf("%s %q service %q want %q", tc.engine, tc.args, got, tc.service)
		}
	}
	if err := ValidateAuth("grok", []string{"--add-dir", "worker", "login"}); err != nil {
		t.Fatalf("documented root directory option rejected before real login: %v", err)
	}
}

func TestWorkerRequiredOptionValuesCannotBecomeDiagnostics(t *testing.T) {
	for _, flag := range []string{"--add-dir", "--name", "--worker-dir", "--max-agents", "--pool-name", "--label", "--labels-file", "--api-key", "--auth-token-file", "--on-session-start", "--on-session-end", "--management-addr", "--idle-release-timeout"} {
		if Has("grok", []string{"worker", flag, "--help"}, "--help") {
			t.Fatalf("%s value became help", flag)
		}
		if Has("grok", []string{"worker", flag, "--version"}, "--version") {
			t.Fatalf("%s value became version", flag)
		}
	}
}
