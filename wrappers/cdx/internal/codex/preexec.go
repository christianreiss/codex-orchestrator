package codex

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/ipv4"
)

// PreExec performs side-effect setup that must happen before Codex is spawned:
//  1. Adds [projects."<cwd>"] trust_level=trusted to ~/.codex/config.toml.
//  2. Exports OTEL_* env vars from any [otel] block in config.toml.
//  3. Starts the IPv4 proxy when CODEX_FORCE_IPV4=1.
//
// Returns a teardown function the caller must defer; it stops the proxy.
func PreExec(ctx context.Context, cfg *config.Config) (func(), error) {
	teardown := func() {}

	// 1) Project-trust auto-add.
	if err := EnsureProjectTrust(); err != nil {
		fmt.Fprintln(os.Stderr, "cdx: project-trust auto-add failed:", err)
	}

	// 2) OTEL env from config.toml.
	if err := exportOTELFromConfig(); err != nil {
		fmt.Fprintln(os.Stderr, "cdx: OTEL env export failed:", err)
	}

	// 3) IPv4 proxy if requested.
	if os.Getenv("CODEX_FORCE_IPV4") == "1" {
		p, err := ipv4.Start(ctx)
		if err != nil {
			fmt.Fprintln(os.Stderr, "cdx: IPv4 proxy failed to start:", err)
		} else {
			_ = os.Setenv("HTTP_PROXY", p.URL)
			_ = os.Setenv("HTTPS_PROXY", p.URL)
			_ = os.Setenv("ALL_PROXY", p.URL)
			teardown = p.Stop
		}
	}
	_ = cfg
	return teardown, nil
}

// EnsureProjectTrust adds [projects."<cwd>"] trust_level="trusted" to
// ~/.codex/config.toml if not already present. cwd is the resolved physical
// path (symlink-following).
func EnsureProjectTrust() error {
	home, _ := os.UserHomeDir()
	cfgPath := filepath.Join(home, ".codex", "config.toml")
	cwd, err := os.Getwd()
	if err != nil {
		return err
	}
	resolved, err := filepath.EvalSymlinks(cwd)
	if err != nil {
		resolved = cwd
	}

	raw, _ := os.ReadFile(cfgPath)
	body := string(raw)
	header := fmt.Sprintf("[projects.\"%s\"]", resolved)
	if strings.Contains(body, header) {
		return nil
	}
	if !strings.HasSuffix(body, "\n") && body != "" {
		body += "\n"
	}
	body += fmt.Sprintf("\n%s\ntrust_level = \"trusted\"\n", header)
	if err := os.MkdirAll(filepath.Dir(cfgPath), 0o700); err != nil {
		return err
	}
	tmp := cfgPath + ".new"
	if err := os.WriteFile(tmp, []byte(body), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, cfgPath)
}

// exportOTELFromConfig parses any [otel] block in ~/.codex/config.toml and
// exports the standard OTEL_* env vars so Codex's tracing picks them up.
// Format expected:
//
//	[otel]
//	endpoint = "https://collector.example.com:4318"
//	protocol = "otlp-http"
//	service_name = "cdx"
//	headers = { Authorization = "Bearer X" }
func exportOTELFromConfig() error {
	home, _ := os.UserHomeDir()
	raw, err := os.ReadFile(filepath.Join(home, ".codex", "config.toml"))
	if err != nil {
		return nil
	}
	lines := strings.Split(string(raw), "\n")
	inOTEL := false
	for _, ln := range lines {
		t := strings.TrimSpace(ln)
		if strings.HasPrefix(t, "[otel") && strings.HasSuffix(t, "]") {
			inOTEL = strings.HasPrefix(t, "[otel]") || strings.HasPrefix(t, "[otel.")
			continue
		}
		if strings.HasPrefix(t, "[") && strings.HasSuffix(t, "]") {
			inOTEL = false
			continue
		}
		if !inOTEL {
			continue
		}
		if !strings.Contains(t, "=") {
			continue
		}
		eq := strings.Index(t, "=")
		key := strings.TrimSpace(t[:eq])
		val := strings.TrimSpace(t[eq+1:])
		val = strings.Trim(val, "\"")
		switch key {
		case "endpoint":
			_ = os.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", val)
		case "protocol":
			_ = os.Setenv("OTEL_EXPORTER_OTLP_PROTOCOL", val)
		case "service_name":
			_ = os.Setenv("OTEL_SERVICE_NAME", val)
		case "traces_exporter":
			_ = os.Setenv("OTEL_TRACES_EXPORTER", val)
		case "resource_attributes":
			_ = os.Setenv("OTEL_RESOURCE_ATTRIBUTES", val)
		case "headers":
			_ = os.Setenv("OTEL_EXPORTER_OTLP_HEADERS", val)
		case "log_user_prompt":
			_ = os.Setenv("CODEX_OTEL_LOG_USER_PROMPT", val)
		}
	}
	return nil
}
