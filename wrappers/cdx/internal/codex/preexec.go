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
//  0. Refuses to launch if the runtime hostname does not match the FQDN baked
//     into config (override with CODEX_ALLOW_FQDN_MISMATCH=1).
//  1. Adds [projects."<cwd>"] trust_level=trusted to ~/.codex/config.toml.
//  2. Exports OTEL_* env vars from any [otel] block in config.toml.
//  3. Starts the IPv4 proxy when CODEX_FORCE_IPV4=1.
//
// Returns a teardown function the caller must defer; it stops the proxy.
func PreExec(ctx context.Context, cfg *config.Config) (func(), error) {
	teardown := func() {}

	// 0) FQDN guard. A signed config has the FQDN baked in; if we boot on a
	// different host (cloned image, mis-deployed wrapper) we refuse rather
	// than mint usage against the wrong host id.
	if err := GuardFQDN(cfg); err != nil {
		return teardown, err
	}

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
	return teardown, nil
}

// GuardFQDN refuses to proceed when the baked cfg.Host.FQDN doesn't match
// the runtime hostname. Suffix match counts (so a baked "alpha.example.com"
// matches a short hostname "alpha"). Override with CODEX_ALLOW_FQDN_MISMATCH=1.
func GuardFQDN(cfg *config.Config) error {
	if cfg == nil || strings.TrimSpace(cfg.Host.FQDN) == "" {
		return nil
	}
	if os.Getenv("CODEX_ALLOW_FQDN_MISMATCH") == "1" {
		return nil
	}
	real, err := os.Hostname()
	if err != nil || strings.TrimSpace(real) == "" {
		// Couldn't determine hostname — fail open so we never block over a
		// transient OS quirk; this matches the legacy bash behaviour.
		return nil
	}
	baked := strings.ToLower(strings.TrimSpace(cfg.Host.FQDN))
	got := strings.ToLower(strings.TrimSpace(real))
	if baked == got {
		return nil
	}
	// Suffix match in either direction handles short hostnames.
	if strings.HasSuffix(got, "."+baked) || strings.HasSuffix(baked, "."+got) {
		return nil
	}
	if strings.HasPrefix(baked, got+".") || strings.HasPrefix(got, baked+".") {
		return nil
	}
	return fmt.Errorf("cdx: hostname %q does not match baked FQDN %q (set CODEX_ALLOW_FQDN_MISMATCH=1 to override)", real, cfg.Host.FQDN)
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
	tmp, err := os.CreateTemp(filepath.Dir(cfgPath), filepath.Base(cfgPath)+".*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	if err := tmp.Chmod(0o644); err != nil {
		tmp.Close()
		_ = os.Remove(tmpName)
		return err
	}
	if _, err := tmp.Write([]byte(body)); err != nil {
		tmp.Close()
		_ = os.Remove(tmpName)
		return err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpName)
		return err
	}
	if err := os.Rename(tmpName, cfgPath); err != nil {
		_ = os.Remove(tmpName)
		return err
	}
	return nil
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
			_ = os.Setenv("OTEL_EXPORTER_OTLP_HEADERS", parseOTELHeaders(val))
		case "log_user_prompt":
			_ = os.Setenv("CODEX_OTEL_LOG_USER_PROMPT", val)
		}
	}
	return nil
}

// parseOTELHeaders converts a TOML inline table such as
// `{ Authorization = "Bearer X", X-Api-Key = "Y" }` into the
// comma-separated `key=value` form OTEL_EXPORTER_OTLP_HEADERS expects.
// Plain `key=value` strings (no braces) pass through unchanged.
func parseOTELHeaders(val string) string {
	v := strings.TrimSpace(val)
	v = strings.TrimPrefix(v, "{")
	v = strings.TrimSuffix(v, "}")
	parts := strings.Split(v, ",")
	pairs := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		eq := strings.Index(p, "=")
		if eq < 0 {
			continue
		}
		k := strings.TrimSpace(p[:eq])
		hv := strings.TrimSpace(p[eq+1:])
		hv = strings.Trim(hv, "\"")
		pairs = append(pairs, k+"="+hv)
	}
	return strings.Join(pairs, ",")
}
