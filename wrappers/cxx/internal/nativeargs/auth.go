package nativeargs

import (
	"fmt"
	"strings"
)

// ValidateAuth checks the structural native auth grammar before a wrapper can
// discard root-only arguments or journal a deferred logout without a native
// child. Semantic config/provider validation remains owned by the native CLI.
func ValidateAuth(engine string, args []string) error {
	command, at := Command(engine, args)
	if command != "login" && command != "logout" {
		return nil
	}
	rootValues := "--config --model --profile --cd --ask-for-approval --sandbox --enable --disable --local-provider --remote --remote-auth-token-env --add-dir --image"
	rootBools := "--oss --approve-for-me --not-so-yolo --dangerously-bypass-approvals-and-sandbox --yolo --dangerously-bypass-hook-trust --worktree --search --no-alt-screen --no-daemon --strict-config"
	globals := "--config --enable --disable"
	loginBools := "--with-api-key --with-access-token --device-auth"
	loginValues := "--experimental_issuer --experimental_client-id --api-key"
	if engine == "grok" {
		rootValues = "--model --single --rules --system-prompt-override --reasoning-effort --allow --deny --cwd --debug-file --leader-socket --agent --agents --prompt-file --prompt-json --output-format --json-schema --max-turns --permission-mode --tools --disallowed-tools --session-id --sandbox --worktree-ref --load --compaction-mode --compaction-detail --background-wait-timeout --storage-mode --client-identifier --hunk-tracker-mode --installer --resume --worktree"
		rootBools = "--debug --always-approve --continue --fork-session --restore-code --no-plan --no-subagents --disable-web-search --verbatim --include-partial-messages --no-ask-user --experimental-memory --no-memory --memory-flush --no-wait-for-background --terminal --fs-read --fs-write --no-auto-update --todo-gate --no-alt-screen --minimal --fullscreen --log-sampling --force-login --oauth --leader --no-leader --trust --trust-folder"
		globals = "--debug --debug-file --leader-socket"
		loginBools = "--legacy --oauth --oidc --device-auth --device-code"
		loginValues = ""
	}
	allowed := func(names, name string) bool {
		for _, item := range strings.Fields(names) {
			if item == name {
				return true
			}
		}
		return false
	}
	table := codex
	if engine == "grok" {
		table = grok
	}
	statusAction := false
	for i := 0; i < len(args); i++ {
		if i == at {
			continue
		}
		raw := args[i]
		if raw == "--" {
			if i == len(args)-1 {
				return nil
			}
			return fmt.Errorf("managed native %s: unexpected argument after --", command)
		}
		if i < at && (raw == "-" || !strings.HasPrefix(raw, "-")) {
			continue
		} // native root prompt
		if engine == "codex" && command == "login" && i > at && raw == "status" && !statusAction {
			statusAction = true
			continue
		}
		if !strings.HasPrefix(raw, "-") {
			return fmt.Errorf("managed native %s: unexpected argument %q", command, raw)
		}
		name, value, end := Option(engine, args, i)
		names := globals
		bools := ""
		if i < at {
			names = rootValues
			bools = rootBools
		} else if command == "login" && !statusAction {
			names += " " + loginValues
			bools = loginBools
		}
		isBool := allowed(bools, name) || engine == "grok" && allowed(globals, name) && name == "--debug"
		if !allowed(names, name) && !isBool {
			return fmt.Errorf("managed native %s: unexpected option %q", command, raw)
		}
		if isBool {
			if strings.Contains(raw, "=") {
				return fmt.Errorf("managed native %s: %s does not take a value", command, name)
			}
			// Do not accept a partial match of an unknown short-option group.
			if strings.HasPrefix(raw, "-") && !strings.HasPrefix(raw, "--") && len(raw) > 2 {
				return fmt.Errorf("managed native %s: grouped auth flags must be supplied separately", command)
			}
		} else {
			spec, known := table[name]
			if known && (spec.arity == required || spec.arity == variadic) {
				if end == i && !strings.Contains(raw, "=") && (raw == name || len(raw) == 2) {
					return fmt.Errorf("managed native %s: %s requires a value", command, name)
				}
				if end > i && strings.HasPrefix(value, "-") && value != "-" {
					return fmt.Errorf("managed native %s: %s requires a value (use = for a value starting with -)", command, name)
				}
			}
		}
		if end >= at && i < at {
			return fmt.Errorf("managed native %s: command consumed as an option value", command)
		}
		i = end
	}
	return nil
}
