package nativeargs

import (
	"os"
	"os/exec"
	"regexp"
	"strings"
	"testing"
)

const nestedUUID = "01234567-89ab-4cde-8fab-0123456789ab"

// Codex 0.165.0 exec/src/cli.rs: `exec resume` and `exec fork` declare
// `-i/--image` with num_args = 1, while root/TUI resume/fork and exec itself
// keep the shared 1.. image list.
func TestCodexNestedExecSessionImageTakesOneValue(t *testing.T) {
	for _, tc := range []struct {
		args    []string
		at, end int
	}{
		{[]string{"exec", "resume", "-i", "a.png", nestedUUID, "continue"}, 2, 3},
		{[]string{"exec", "resume", "--image", "a.png", nestedUUID}, 2, 3},
		{[]string{"e", "resume", "--image", "a.png", nestedUUID}, 2, 3},
		{[]string{"exec", "fork", "-i", "a.png", nestedUUID}, 2, 3},
		{[]string{"e", "fork", "--image", "a.png", "b.png"}, 2, 3},
		{[]string{"exec", "--model", "m", "resume", "--image", "a.png", "b.png"}, 4, 5},
		{[]string{"exec", "resume", nestedUUID, "-i", "a.png", "prompt"}, 3, 4},
		{[]string{"--model", "exec", "exec", "resume", "-i", "a.png", nestedUUID}, 4, 5},
		// Shared 1.. lists before the nested command and in TUI commands.
		{[]string{"resume", "-i", "a.png", nestedUUID}, 1, 3},
		{[]string{"fork", "--image", "a.png", nestedUUID}, 1, 3},
		{[]string{"exec", "-i", "a.png", "resume", nestedUUID}, 1, 4},
		{[]string{"-i", "a.png", "exec", "resume", nestedUUID}, 0, 4},
		{[]string{"exec", "review", "--base", "main", "-i", "a.png", "b.png"}, 4, 6},
		// Image values named exec/resume do not open a nested session command.
		{[]string{"--image", "exec", "resume", "-i", "a.png", "b.png"}, 3, 5},
	} {
		if got := ValueEnd("codex", tc.args, tc.at); got != tc.end {
			t.Errorf("%q at %d: end %d want %d", tc.args, tc.at, got, tc.end)
		}
	}
	if Resumed("codex", []string{"exec", "-i", "a.png", "resume", nestedUUID}) {
		t.Fatal("exec image list value became nested resume")
	}
	if !Resumed("codex", []string{"exec", "resume", "-i", "a.png", nestedUUID}) {
		t.Fatal("nested resume lost")
	}
}

// codex0165ValueOptions is the value-taking option corpus of `codex <path>
// --help` for Codex 0.165.0 (collected 2026-10-28 in a throwaway CODEX_HOME).
// Readers descend through root, exec, exec resume|fork|review, review, resume,
// fork, queue, archive, unarchive, delete and agents; utility and refused
// command options are listed too so their values never become commands or flags.
var codex0165ValueOptions = []struct{ path, options string }{
	{"", "-c, --config <key=value>; --enable <FEATURE>; --disable <FEATURE>; --remote <ADDR>; --remote-auth-token-env <ENV_VAR>; -i, --image <FILE>...; -m, --model <MODEL>; --local-provider <OSS_PROVIDER>; -p, --profile <CONFIG_PROFILE_V2>; -s, --sandbox <SANDBOX_MODE>; -C, --cd <DIR>; --add-dir <DIR>; -a, --ask-for-approval <APPROVAL_POLICY>"},
	{"exec", "-c, --config <key=value>; --enable <FEATURE>; --disable <FEATURE>; -i, --image <FILE>...; -m, --model <MODEL>; --local-provider <OSS_PROVIDER>; -p, --profile <CONFIG_PROFILE_V2>; -s, --sandbox <SANDBOX_MODE>; -C, --cd <DIR>; --add-dir <DIR>; --thread-source <SOURCE>; --cyber-access-program <PROGRAM>; --output-schema <FILE>; --color <COLOR>; -o, --output-last-message <FILE>"},
	{"exec resume", "-c, --config <key=value>; --enable <FEATURE>; --disable <FEATURE>; -i, --image <FILE>; -m, --model <MODEL>; --thread-source <SOURCE>; --cyber-access-program <PROGRAM>; --output-schema <FILE>; -o, --output-last-message <FILE>"},
	{"exec fork", "-c, --config <key=value>; -i, --image <FILE>; --enable <FEATURE>; --disable <FEATURE>; -m, --model <MODEL>; --thread-source <SOURCE>; --cyber-access-program <PROGRAM>; --output-schema <FILE>; -o, --output-last-message <FILE>"},
	{"exec review", "-c, --config <key=value>; --base <BRANCH>; --enable <FEATURE>; --commit <SHA>; --disable <FEATURE>; --title <TITLE>; -m, --model <MODEL>; --thread-source <SOURCE>; --cyber-access-program <PROGRAM>; --output-schema <FILE>; -o, --output-last-message <FILE>"},
	{"review", "-c, --config <key=value>; --enable <FEATURE>; --base <BRANCH>; --disable <FEATURE>; --commit <SHA>; --title <TITLE>"},
	{"resume", "-c, --config <key=value>; --enable <FEATURE>; --disable <FEATURE>; --remote <ADDR>; --remote-auth-token-env <ENV_VAR>; -i, --image <FILE>...; -m, --model <MODEL>; --local-provider <OSS_PROVIDER>; -p, --profile <CONFIG_PROFILE_V2>; -s, --sandbox <SANDBOX_MODE>; -C, --cd <DIR>; --add-dir <DIR>; -a, --ask-for-approval <APPROVAL_POLICY>"},
	{"fork", "-c, --config <key=value>; --enable <FEATURE>; --disable <FEATURE>; --remote <ADDR>; --remote-auth-token-env <ENV_VAR>; -i, --image <FILE>...; -m, --model <MODEL>; --local-provider <OSS_PROVIDER>; -p, --profile <CONFIG_PROFILE_V2>; -s, --sandbox <SANDBOX_MODE>; -C, --cd <DIR>; --add-dir <DIR>; -a, --ask-for-approval <APPROVAL_POLICY>"},
	{"queue", "--thread <THREAD>; --enable <FEATURE>; --message <TEXT>; --disable <FEATURE>; --remote <ADDR>; --remote-auth-token-env <ENV_VAR>; -i, --image <FILE>...; -m, --model <MODEL>; --local-provider <OSS_PROVIDER>; -p, --profile <CONFIG_PROFILE_V2>; -s, --sandbox <SANDBOX_MODE>; -C, --cd <DIR>; --add-dir <DIR>; -c, --config <key=value>"},
	{"archive", "--remote <ADDR>; --enable <FEATURE>; --remote-auth-token-env <ENV_VAR>; --disable <FEATURE>; -i, --image <FILE>...; -m, --model <MODEL>; --local-provider <OSS_PROVIDER>; -p, --profile <CONFIG_PROFILE_V2>; -s, --sandbox <SANDBOX_MODE>; -C, --cd <DIR>; --add-dir <DIR>; -c, --config <key=value>"},
	{"unarchive", "--remote <ADDR>; --enable <FEATURE>; --remote-auth-token-env <ENV_VAR>; --disable <FEATURE>; -i, --image <FILE>...; -m, --model <MODEL>; --local-provider <OSS_PROVIDER>; -p, --profile <CONFIG_PROFILE_V2>; -s, --sandbox <SANDBOX_MODE>; -C, --cd <DIR>; --add-dir <DIR>; -c, --config <key=value>"},
	{"delete", "--remote <ADDR>; --enable <FEATURE>; --remote-auth-token-env <ENV_VAR>; --disable <FEATURE>; -i, --image <FILE>...; -m, --model <MODEL>; --local-provider <OSS_PROVIDER>; -p, --profile <CONFIG_PROFILE_V2>; -s, --sandbox <SANDBOX_MODE>; -C, --cd <DIR>; --add-dir <DIR>; -c, --config <key=value>"},
	{"agents", "-c, --config <key=value>; --enable <FEATURE>; --remote <ADDR>; --disable <FEATURE>; --remote-auth-token-env <ENV_VAR>; -C, --cd <DIR>"},
	{"login", "-c, --config <key=value>; --enable <FEATURE>; --disable <FEATURE>"},
	{"migrate-rollouts", "-c, --config <key=value>; --enable <FEATURE>; --thread <THREAD_ID>; --disable <FEATURE>; --max-mib-per-second <MIB>"},
	{"migrate-nfs-db", "-c, --config <key=value>; --staging-dir <STAGING_DIR>; --enable <FEATURE>; --disable <FEATURE>"},
	{"sandbox", "-c, --config <key=value>; --sandbox-state-json <JSON>; --enable <FEATURE>; --sandbox-state-readable-root <SANDBOX_STATE_READABLE_ROOT>; --disable <FEATURE>; -P, --permission-profile <NAME>; -p, --profile <CONFIG_PROFILE>; -C, --cd <DIR>"},
	{"mcp add", "-c, --config <key=value>; --env <KEY=VALUE>; --enable <FEATURE>; --url <URL>; --bearer-token-env-var <ENV_VAR>; --disable <FEATURE>; --oauth-client-id <CLIENT_ID>; --oauth-client-secret <CLIENT_SECRET>; --oauth-client-registration <AUTO|CIMD|DCR>; --oauth-resource <RESOURCE>"},
	{"mcp login", "-c, --config <key=value>; --enable <FEATURE>; --scopes <SCOPE,SCOPE>; --disable <FEATURE>; --oauth-client-registration <AUTO|CIMD|DCR>"},
	{"app-server", "-c, --config <key=value>; --enable <FEATURE>; --disable <FEATURE>; --startup-client-info <STARTUP_CLIENT_INFO>; --cloud-skills-snapshot <PATH>; --code-mode-host <URL>; --listen <URL>; --ws-auth <MODE>; --ws-token-file <PATH>; --ws-shared-secret-file <PATH>; --ws-issuer <ISSUER>; --ws-audience <AUDIENCE>; --ws-max-clock-skew-seconds <SECONDS>"},
	{"exec-server", "-c, --config <key=value>; --enable <FEATURE>; --disable <FEATURE>; --linux-sandbox-pid-namespace <MODE>; --concurrent-requests <COUNT>; --listen <URL>; --ws-auth <MODE>; --ws-token-file <PATH>; --ws-shared-secret-file <PATH>; --ws-issuer <ISSUER>; --ws-audience <AUDIENCE>; --ws-max-clock-skew-seconds <SECONDS>; --remote <URL>; --remote-transport <REMOTE_TRANSPORT>; --environment-id <ID>; --name <NAME>; --aws-profile <PROFILE>; --aws-region <REGION>; --aws-service <SERVICE>"},
	{"cloud exec", "-c, --config <key=value>; --env <ENV_ID>; --attempts <ATTEMPTS>; --enable <FEATURE>; --branch <BRANCH>; --disable <FEATURE>"},
	{"cloud list", "-c, --config <key=value>; --env <ENV_ID>; --enable <FEATURE>; --limit <N>; --cursor <CURSOR>; --disable <FEATURE>"},
	{"cloud apply", "--attempt <N>; -c, --config <key=value>; --enable <FEATURE>; --disable <FEATURE>"},
	{"plugin add", "-c, --config <key=value>; -m, --marketplace <MARKETPLACE>; --enable <FEATURE>; --disable <FEATURE>"},
}

var helpOption = regexp.MustCompile(`^(?:(-[A-Za-z]), )?(--[A-Za-z][A-Za-z0-9_-]*) (\[?)<[^>]+>\]?(\.\.\.)?$`)

// assertValueOption checks one native help option line against the shared
// table at the command position where native parses it.
func assertValueOption(t *testing.T, path []string, line string) {
	t.Helper()
	match := helpOption.FindStringSubmatch(strings.TrimSpace(line))
	if match == nil {
		t.Fatalf("%q: unparsed help option %q", path, line)
	}
	short, long, optional, list := match[1], match[2], match[3] == "[", match[4] != ""
	for _, flag := range []string{long, short} {
		if flag == "" {
			continue
		}
		args := append(append([]string{}, path...), flag, "first", "second")
		at := len(path)
		name, value, end := Option("codex", args, at)
		want := at + 1
		if list {
			want = at + 2
		}
		// `plugin add -m` shares the letter and required arity of --model.
		if flag == long && name != long {
			t.Errorf("codex %q %s canonicalized as %q", path, flag, name)
		}
		if value != "first" || end != want {
			t.Errorf("codex %q %s (optional=%v list=%v): value %q end %d want %d", path, flag, optional, list, value, end, want)
		}
	}
}

func TestCodex0165ValueOptionCorpus(t *testing.T) {
	for _, cmd := range codex0165ValueOptions {
		for _, line := range strings.Split(cmd.options, ";") {
			assertValueOption(t, strings.Fields(cmd.path), line)
		}
	}
	// Queue values stay opaque even when they look like commands or flags.
	args := []string{"queue", "--thread", "login", "--message", "--remote"}
	if command, _ := Command("codex", args); command != "queue" || Value("codex", args, "--message") != "--remote" || Has("codex", args, "--remote") {
		t.Fatalf("queue values reinterpreted: %q", args)
	}
	if UnsupportedService("codex", []string{"queue", "--thread", "t", "--message", "agents"}) != "" {
		t.Fatal("queue message named agents became a refused command")
	}
}

// Opt-in: NATIVE_CODEX_ORACLE=/path/to/codex compares every value-taking option
// of the live native help with the shared table (no auth, throwaway home).
func TestCodexValueOptionHelpOracle(t *testing.T) {
	binary := os.Getenv("NATIVE_CODEX_ORACLE")
	if binary == "" {
		t.Skip("native help oracle not configured")
	}
	line := regexp.MustCompile(`^\s+(?:-[A-Za-z], )?--[A-Za-z][A-Za-z0-9_-]* \[?<`)
	for _, cmd := range codex0165ValueOptions {
		home := t.TempDir()
		path := strings.Fields(cmd.path)
		run := exec.Command(binary, append(append([]string{}, path...), "--help")...)
		run.Env = []string{"HOME=" + home, "CODEX_HOME=" + home, "PATH=" + os.Getenv("PATH")}
		out, err := run.Output()
		if err != nil {
			t.Fatalf("%q --help: %v", path, err)
		}
		for _, raw := range strings.Split(string(out), "\n") {
			if line.MatchString(raw) {
				option := strings.TrimSpace(raw)
				if cut := strings.Index(option, "  "); cut > 0 {
					option = option[:cut]
				}
				assertValueOption(t, path, option)
			}
		}
	}
}
