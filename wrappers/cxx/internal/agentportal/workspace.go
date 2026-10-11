package agentportal

import (
	"context"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type Workspace struct {
	Cwd          string  `json:"cwd"`
	GitStatus    string  `json:"git_status"`
	GitRoot      *string `json:"git_root"`
	GitCommonDir *string `json:"git_common_dir"`
	OriginURL    *string `json:"origin_url,omitempty"`
}

// Native directory options are launch facts. A prompt or an option's value
// containing --cd/--cwd is not an option, and -- ends option parsing.
func launchCwd(engine string, args []string) (string, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for at := 0; at < len(args); at++ {
		arg := args[at]
		if arg == "--" {
			break
		}
		flag, value, inline := strings.Cut(arg, "=")
		isDir := engine == "codex" && (flag == "--cd" || flag == "-C") || engine == "grok" && flag == "--cwd"
		if isDir {
			if !inline && at+1 < len(args) {
				at++
				value = args[at]
			}
			if value != "" {
				cwd = value
			}
			continue
		}
		if engine == "codex" && strings.HasPrefix(arg, "-C") && len(arg) > 2 {
			cwd = arg[2:]
			continue
		}
		consumes := identityValueFlag(engine, flag)
		if engine == "grok" {
			switch flag {
			case "-p", "--single", "--prompt-json", "--system-prompt-override", "--agents", "--allow", "--deny", "--tools", "--disallowed-tools", "--reasoning-effort", "--leader-socket", "-s":
				consumes = true
			}
		}
		if !inline && consumes && at+1 < len(args) && !((flag == "--resume" || flag == "-r") && strings.HasPrefix(args[at+1], "-")) {
			at++
		}
	}
	return filepath.Abs(cwd)
}

func canonicalPath(path string) string {
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		return filepath.Clean(resolved)
	}
	return filepath.Clean(path)
}

// Capture locally with a bounded, read-only Git probe. No remote access, hooks,
// Director registration or changes to the process's working directory.
func captureWorkspace(parent context.Context, cwd string) Workspace {
	w := Workspace{Cwd: canonicalPath(cwd), GitStatus: "unavailable"}
	ctx, cancel := context.WithTimeout(parent, 2*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", "-C", cwd, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir")
	cmd.Env = append(os.Environ(), "LC_ALL=C", "GIT_OPTIONAL_LOCKS=0")
	out, err := cmd.CombinedOutput()
	if err != nil {
		if strings.Contains(string(out), "not a git repository") {
			w.GitStatus = "none"
		}
		return w
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	if len(lines) != 2 || !filepath.IsAbs(lines[0]) || !filepath.IsAbs(lines[1]) {
		return w
	}
	root, common := canonicalPath(lines[0]), canonicalPath(lines[1])
	w.GitStatus, w.GitRoot, w.GitCommonDir = "repository", &root, &common
	remote := exec.CommandContext(ctx, "git", "-C", cwd, "config", "--get", "remote.origin.url")
	if raw, err := remote.Output(); err == nil {
		if origin := discoveryOrigin(strings.TrimSpace(string(raw))); origin != "" && len(origin) <= 4096 {
			w.OriginURL = &origin
		}
	}
	return w
}

// Drop credentials and URL query/fragment before sending anything to the API.
// Local filesystem remotes are not globally unique project identifiers.
func discoveryOrigin(raw string) string {
	raw = strings.SplitN(strings.SplitN(raw, "?", 2)[0], "#", 2)[0]
	if strings.Contains(raw, "://") {
		u, err := url.Parse(raw)
		if err != nil || u.Host == "" {
			return ""
		}
		switch strings.ToLower(u.Scheme) {
		case "https", "http", "ssh", "git":
		default:
			return ""
		}
		u.User, u.RawQuery, u.Fragment = nil, "", ""
		return u.String()
	}
	host, path, ok := strings.Cut(raw, ":")
	if !ok || host == "" || path == "" || strings.HasPrefix(path, ":") || strings.ContainsAny(host, "/\\") {
		return ""
	}
	if at := strings.LastIndex(host, "@"); at >= 0 {
		host = host[at+1:]
	}
	if host == "" {
		return ""
	}
	return host + ":" + path
}
