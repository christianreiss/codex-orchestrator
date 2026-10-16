package memoryrouting

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode/utf16"
)

func targets(engine, home string, enabled bool, args []string) ([]string, error) {
	paths := map[string]bool{}
	add := func(path string) { paths[filepath.Clean(path)] = true }
	scan := func(root string, suffix ...string) error {
		entries, err := os.ReadDir(root)
		if os.IsNotExist(err) {
			return nil
		}
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if entry.IsDir() {
				path := filepath.Join(append([]string{root, entry.Name()}, suffix...)...)
				if _, err := os.Lstat(path); err == nil {
					add(path)
				} else if !os.IsNotExist(err) {
					return err
				}
			}
		}
		return nil
	}
	switch engine {
	case "codex":
		add(filepath.Join(home, "memories", "MEMORY.md"))
		add(filepath.Join(home, "memories", "memory_summary.md"))
	case "claude":
		if enabled {
			dir, err := claudeMemoryDir(home, args)
			if err != nil {
				return nil, err
			}
			if dir == "" {
				break
			}
			add(filepath.Join(dir, "MEMORY.md"))
		}
		if err := scan(filepath.Join(home, "projects"), "memory", "MEMORY.md"); err != nil {
			return nil, err
		}
	case "grok":
		add(filepath.Join(home, "memory", "MEMORY.md"))
		add(filepath.Join(home, "memory-v2", "global", "MEMORY.md"))
		add(filepath.Join(home, "memory-v2", "global", "topics", topicName))
		for _, root := range []string{filepath.Join(home, "memory"), filepath.Join(home, "memory", "workspaces"), filepath.Join(home, "memory-v2", "workspaces")} {
			if err := scan(root, "MEMORY.md"); err != nil {
				return nil, err
			}
		}
	default:
		return nil, fmt.Errorf("unknown memory routing engine %q", engine)
	}
	out := make([]string, 0, len(paths))
	for path := range paths {
		out = append(out, path)
	}
	sort.Strings(out)
	return out, nil
}

// Memory and local consent settings share the canonical repository root;
// project settings belong to the session's working directory.
func projectRoots(cwd string) (memoryRoot, workspaceRoot string) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", "-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel")
	if out, err := cmd.Output(); err == nil {
		lines := strings.Split(strings.TrimSpace(string(out)), "\n")
		if len(lines) == 2 && filepath.IsAbs(lines[1]) {
			workspaceRoot = lines[1]
			memoryRoot = workspaceRoot
			if filepath.IsAbs(lines[0]) && filepath.Base(lines[0]) == ".git" {
				memoryRoot = filepath.Dir(lines[0])
			}
			if canonical, err := filepath.EvalSymlinks(memoryRoot); err == nil {
				memoryRoot = canonical
			}
			return memoryRoot, workspaceRoot
		}
	}
	if canonical, err := filepath.EvalSymlinks(cwd); err == nil {
		return canonical, canonical
	}
	return cwd, cwd
}

// Mirrors Claude's native sanitizer, including its UTF-16 hash for long paths.
func claudeProjectKey(path string) string {
	units := utf16.Encode([]rune(path))
	clean := make([]byte, len(units))
	var hash int32
	for i, unit := range units {
		hash = hash*31 + int32(unit)
		clean[i] = '-'
		if unit >= 'a' && unit <= 'z' || unit >= 'A' && unit <= 'Z' || unit >= '0' && unit <= '9' {
			clean[i] = byte(unit)
		}
	}
	if len(clean) <= 200 {
		return string(clean)
	}
	value := int64(hash)
	if value < 0 {
		value = -value
	}
	return string(clean[:200]) + "-" + strconv.FormatInt(value, 36)
}

func claudeMemoryDir(home string, args []string) (string, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	root, workspace := projectRoots(cwd)
	userHome := filepath.Dir(home)
	// The lifecycle filters native option values before passing selectors here.
	// Also honor the literal separator for direct callers.
	var settingsArgs []string
	// --setting-sources can intentionally omit native user/project/local settings.
	sources := map[string]bool{"user": true, "project": true, "local": true}
	for i := 0; i < len(args); i++ {
		if args[i] == "--" {
			break
		}
		name, value, inline := strings.Cut(args[i], "=")
		if (name == "--settings" || name == "--setting-sources") && !inline && i+1 < len(args) && args[i+1] != "--" {
			i++
			value, inline = args[i], true
		}
		if name == "--setting-sources" && inline {
			sources = map[string]bool{}
			for _, source := range strings.Split(value, ",") {
				sources[strings.TrimSpace(source)] = true
			}
		} else if name == "--settings" && value != "" {
			settingsArgs = append(settingsArgs, value)
		}
	}
	var selected string
	var repositorySelected bool
	readRestrictions := map[string]bool{}
	applySettings := func(raw []byte, repository bool, source string) error {
		var settings struct {
			Directory   *string `json:"autoMemoryDirectory"`
			Permissions struct {
				BlockReads *bool `json:"blockReadsOutsideWorkingDirectories"`
			} `json:"permissions"`
		}
		if err := json.Unmarshal(raw, &settings); err != nil {
			return err
		}
		if settings.Directory != nil {
			selected, repositorySelected = *settings.Directory, repository
		}
		if settings.Permissions.BlockReads != nil {
			// Native Claude treats this as a restriction: true in any enabled
			// scope wins, including over a later false value.
			readRestrictions[source] = *settings.Permissions.BlockReads
		}
		return nil
	}
	readSettings := func(path string, repository bool, source string) error {
		raw, err := os.ReadFile(path)
		if os.IsNotExist(err) {
			return nil
		}
		if err != nil {
			return err
		}
		if err := applySettings(raw, repository, source); err != nil {
			return fmt.Errorf("read memory settings %s: %w", path, err)
		}
		return nil
	}
	if sources["user"] {
		if err := readSettings(filepath.Join(home, "settings.json"), false, "user"); err != nil {
			return "", err
		}
	}
	// Only consume repository path selectors after native workspace trust.
	var trust struct {
		Projects map[string]struct {
			Accepted     bool `json:"hasTrustDialogAccepted"`
			LocalTracked bool `json:"localSettingsSeenGitTracked"`
		} `json:"projects"`
	}
	if raw, err := os.ReadFile(filepath.Join(userHome, ".claude.json")); err == nil {
		_ = json.Unmarshal(raw, &trust)
	}
	if trust.Projects[workspace].Accepted || trust.Projects[root].Accepted || trust.Projects[cwd].Accepted {
		localRoot := claudeLocalSettingsRoot(cwd, root, userHome)
		localRepository := trust.Projects[root].LocalTracked || trust.Projects[workspace].LocalTracked || trust.Projects[cwd].LocalTracked
		localRepository = localRepository || claudeLocalSettingsInRepository(cwd)
		if localRoot != cwd {
			localRepository = localRepository || claudeLocalSettingsInRepository(localRoot)
		}
		type settingsFile struct {
			source, path string
			repository   bool
		}
		entries := []settingsFile{
			{"project", filepath.Join(cwd, ".claude", "settings.json"), true},
		}
		// Native keeps older cwd-local settings below the canonical consent
		// store, so existing subdirectory/worktree preferences still apply.
		if localRoot != cwd {
			entries = append(entries, settingsFile{"local", filepath.Join(cwd, ".claude", "settings.local.json"), localRepository})
		}
		entries = append(entries, settingsFile{"local", filepath.Join(localRoot, ".claude", "settings.local.json"), localRepository})
		for _, entry := range entries {
			if sources[entry.source] {
				if err := readSettings(entry.path, entry.repository, entry.source); err != nil {
					return "", err
				}
			}
		}
	}
	for _, value := range settingsArgs {
		if strings.HasPrefix(strings.TrimSpace(value), "{") {
			if err := applySettings([]byte(value), false, "flag"); err != nil {
				return "", errors.New("invalid --settings JSON for memory routing")
			}
		} else if err := readSettings(value, false, "flag"); err != nil {
			return "", err
		}
	}
	policy := os.Getenv("CLAUDE_CODE_MANAGED_SETTINGS_PATH")
	if policy == "" {
		policy = "/etc/claude-code/managed-settings.json"
		if runtime.GOOS == "darwin" {
			policy = "/Library/Application Support/ClaudeCode/managed-settings.json"
		}
	}
	if err := readSettings(policy, false, "policy"); err != nil {
		return "", err
	}
	// Native Claude disables memory selected by repository settings while this
	// read boundary is active, even when the directory is inside the workspace.
	if repositorySelected {
		for _, restricted := range readRestrictions {
			if restricted {
				return "", nil
			}
		}
	}
	if strings.HasPrefix(selected, "~/") {
		selected = filepath.Join(userHome, strings.TrimPrefix(selected, "~/"))
	}
	if selected != "" {
		if !filepath.IsAbs(selected) {
			return "", errors.New("autoMemoryDirectory must be absolute or start with ~/")
		}
		return filepath.Clean(selected), nil
	}
	// The managed wrapper removes CLAUDE_CONFIG_DIR before launching Claude;
	// CLAUDE_CODE_PROJECT_DIR_NAME only applies together with that variable.
	return filepath.Join(home, "projects", claudeProjectKey(root), "memory"), nil
}

// Claude canonicalizes local consent only on POSIX repositories owned by the
// current user, and never into the home directory's repository (2.1.301).
func claudeLocalSettingsRoot(cwd, root, userHome string) string {
	if runtime.GOOS == "windows" || root == userHome {
		return cwd
	}
	for _, name := range []string{"", ".git", ".claude"} {
		info, err := os.Lstat(filepath.Join(root, name))
		if os.IsNotExist(err) && name == ".claude" {
			continue
		}
		if err != nil {
			return cwd
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || stat.Uid != uint32(os.Geteuid()) {
			return cwd
		}
	}
	return root
}

// An untracked local file is operator-owned. A linked .claude directory or a
// tracked local file is repository-supplied and subject to the read boundary.
func claudeLocalSettingsInRepository(dir string) bool {
	// No path selector can come from an absent local file. Avoid starting Git
	// during the common launch with no local settings at either location.
	if _, err := os.Lstat(filepath.Join(dir, ".claude", "settings.local.json")); os.IsNotExist(err) {
		return false
	}
	for _, path := range []string{filepath.Join(dir, ".claude"), filepath.Join(dir, ".claude", "settings.local.json")} {
		if info, err := os.Lstat(path); err == nil && info.Mode()&os.ModeSymlink != 0 {
			return true
		}
	}
	if _, err := os.Lstat(filepath.Join(dir, ".claude", ".git")); err == nil {
		return true
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", "-C", dir, "ls-files", "--error-unmatch", "--", ":(icase).claude/settings.local.json")
	cmd.Env = append(os.Environ(), "GIT_LITERAL_PATHSPECS=")
	err := cmd.Run()
	if err == nil {
		return true
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) && exit.ExitCode() == 1 {
		return false
	}
	// Unknown provenance must not bypass the native restriction.
	return true
}
