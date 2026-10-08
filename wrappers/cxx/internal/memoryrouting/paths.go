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
		if err := scan(filepath.Join(home, "projects"), "memory", "MEMORY.md"); err != nil {
			return nil, err
		}
		if enabled {
			dir, err := claudeMemoryDir(home, args)
			if err != nil {
				return nil, err
			}
			add(filepath.Join(dir, "MEMORY.md"))
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

// Memory is shared across worktrees; repository settings belong to the active one.
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
	// --setting-sources can intentionally omit native user/project/local settings.
	sources := map[string]bool{"user": true, "project": true, "local": true}
	for i := 0; i < len(args); i++ {
		var value string
		found := false
		if args[i] == "--setting-sources" && i+1 < len(args) {
			i++
			value, found = args[i], true
		} else if strings.HasPrefix(args[i], "--setting-sources=") {
			value, found = strings.TrimPrefix(args[i], "--setting-sources="), true
		}
		if found {
			sources = map[string]bool{}
			for _, source := range strings.Split(value, ",") {
				sources[strings.TrimSpace(source)] = true
			}
		}
	}
	var selected string
	readSettings := func(path string) error {
		raw, err := os.ReadFile(path)
		if os.IsNotExist(err) {
			return nil
		}
		if err != nil {
			return err
		}
		var settings struct {
			Directory *string `json:"autoMemoryDirectory"`
		}
		if err := json.Unmarshal(raw, &settings); err != nil {
			return fmt.Errorf("read memory settings %s: %w", path, err)
		}
		if settings.Directory != nil {
			selected = *settings.Directory
		}
		return nil
	}
	if sources["user"] {
		if err := readSettings(filepath.Join(home, "settings.json")); err != nil {
			return "", err
		}
	}
	// Only consume repository path selectors after native workspace trust.
	var trust struct {
		Projects map[string]struct {
			Accepted bool `json:"hasTrustDialogAccepted"`
		} `json:"projects"`
	}
	if raw, err := os.ReadFile(filepath.Join(userHome, ".claude.json")); err == nil {
		_ = json.Unmarshal(raw, &trust)
	}
	if trust.Projects[workspace].Accepted || trust.Projects[root].Accepted || trust.Projects[cwd].Accepted {
		for _, entry := range []struct{ source, name string }{{"project", "settings.json"}, {"local", "settings.local.json"}} {
			if sources[entry.source] {
				if err := readSettings(filepath.Join(workspace, ".claude", entry.name)); err != nil {
					return "", err
				}
			}
		}
	}
	for i := 0; i < len(args); i++ {
		var value string
		if args[i] == "--settings" && i+1 < len(args) {
			i++
			value = args[i]
		} else if strings.HasPrefix(args[i], "--settings=") {
			value = strings.TrimPrefix(args[i], "--settings=")
		}
		if value == "" {
			continue
		}
		if strings.HasPrefix(strings.TrimSpace(value), "{") {
			var settings struct {
				Directory *string `json:"autoMemoryDirectory"`
			}
			if err := json.Unmarshal([]byte(value), &settings); err != nil {
				return "", errors.New("invalid --settings JSON for memory routing")
			}
			if settings.Directory != nil {
				selected = *settings.Directory
			}
		} else if err := readSettings(value); err != nil {
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
	if err := readSettings(policy); err != nil {
		return "", err
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
