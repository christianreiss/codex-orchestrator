package peer

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/orchestrator"
)

const peerEngine = "codex"
const peerName = "cdx"

type bundle struct {
	Payload   map[string]any `json:"payload"`
	Signature struct {
		Value string `json:"value"`
	} `json:"signature"`
}

func Reconcile(ctx context.Context, cfg *config.Config, auth *orchestrator.AuthRetrieveResponse, logger *slog.Logger) {
	engines, ok := desiredEngines(cfg, auth)
	if !ok {
		return
	}
	if hasEngine(engines, peerEngine) {
		if err := installPeer(ctx, cfg); err != nil {
			logger.Warn("peer wrapper install skipped", "engine", peerEngine, "err", err)
		}
		return
	}
	if err := removePeer(ctx, logger); err != nil {
		logger.Warn("peer wrapper removal skipped", "engine", peerEngine, "err", err)
	}
}

func desiredEngines(cfg *config.Config, auth *orchestrator.AuthRetrieveResponse) ([]string, bool) {
	if auth != nil && auth.Host != nil {
		if len(auth.Host.EnginesList) > 0 {
			return auth.Host.EnginesList, true
		}
		if strings.TrimSpace(auth.Host.Engines) != "" {
			return splitEngines(auth.Host.Engines), true
		}
	}
	if cfg != nil {
		if len(cfg.Host.EnginesList) > 0 {
			return cfg.Host.EnginesList, true
		}
		if strings.TrimSpace(cfg.Host.Engines) != "" {
			return splitEngines(cfg.Host.Engines), true
		}
	}
	return nil, false
}

func splitEngines(raw string) []string {
	var out []string
	for _, part := range strings.Split(raw, ",") {
		if v := strings.TrimSpace(strings.ToLower(part)); v != "" {
			out = append(out, v)
		}
	}
	return out
}

func hasEngine(engines []string, want string) bool {
	for _, e := range engines {
		if strings.EqualFold(strings.TrimSpace(e), want) {
			return true
		}
	}
	return false
}

func installPeer(ctx context.Context, cfg *config.Config) error {
	b, rawPayload, err := fetchBundle(ctx, cfg)
	if err != nil {
		return err
	}
	wrapper, ok := b.Payload["wrapper"].(map[string]any)
	if !ok {
		return errors.New("peer config missing wrapper block")
	}
	url, _ := wrapper["binary_url"].(string)
	sum, _ := wrapper["binary_sha256"].(string)
	if strings.TrimSpace(url) == "" || strings.TrimSpace(sum) == "" {
		return errors.New("peer wrapper metadata incomplete")
	}
	if err := writePeerConfig(rawPayload, b.Signature.Value); err != nil {
		return err
	}
	return installPeerBinary(ctx, cfg, url, sum)
}

func fetchBundle(ctx context.Context, cfg *config.Config) (*bundle, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, cfg.Orchestrator.BaseURL+"/wrapper/v2/config?engine="+peerEngine, nil)
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("X-API-Key", cfg.Orchestrator.APIKey)
	req.Header.Set("X-Wrapper-Platform", runtime.GOOS+"-"+runtime.GOARCH)
	resp, err := httpClient(cfg).Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return nil, nil, fmt.Errorf("peer config HTTP %d", resp.StatusCode)
	}
	var b bundle
	if err := json.NewDecoder(resp.Body).Decode(&b); err != nil {
		return nil, nil, err
	}
	if b.Payload == nil || b.Signature.Value == "" {
		return nil, nil, errors.New("peer config bundle incomplete")
	}
	rawPayload, err := json.Marshal(b.Payload)
	if err != nil {
		return nil, nil, err
	}
	return &b, rawPayload, nil
}

func httpClient(cfg *config.Config) *http.Client {
	if !cfg.Orchestrator.AllowInsecure {
		return http.DefaultClient
	}
	return &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}}
}

func writePeerConfig(payload []byte, sig string) error {
	path := peerConfigPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(path, payload, 0o600); err != nil {
		return err
	}
	return os.WriteFile(path+".sig", []byte(sig), 0o600)
}

func peerConfigPath() string {
	if env := strings.TrimSpace(os.Getenv("CDX_CONFIG_PATH")); env != "" {
		return env
	}
	if xdg := strings.TrimSpace(os.Getenv("XDG_CONFIG_HOME")); xdg != "" {
		return filepath.Join(xdg, "codex-orchestrator", "cdx.json")
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "codex-orchestrator", "cdx.json")
}

func installPeerBinary(ctx context.Context, cfg *config.Config, url, expected string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("X-API-Key", cfg.Orchestrator.APIKey)
	resp, err := httpClient(cfg).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("peer binary HTTP %d", resp.StatusCode)
	}
	tmp, err := os.CreateTemp("", "cdx-peer-*.new")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if _, err := io.Copy(tmp, resp.Body); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := verifySHA256(tmpPath, expected); err != nil {
		return err
	}
	return installFile(tmpPath, peerBinaryPath())
}

func peerBinaryPath() string {
	if p, err := exec.LookPath(peerName); err == nil && p != "" {
		return p
	}
	if exe, err := os.Executable(); err == nil {
		if resolved, rerr := filepath.EvalSymlinks(exe); rerr == nil {
			exe = resolved
		}
		return filepath.Join(filepath.Dir(exe), peerName)
	}
	return filepath.Join("/usr/local/bin", peerName)
}

func installFile(src, dest string) error {
	tmp := dest + ".new"
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return sudoInstall(src, dest, err)
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := out.Close(); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Chmod(tmp, 0o755); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, dest); err != nil {
		_ = os.Remove(tmp)
		return sudoInstall(src, dest, err)
	}
	return nil
}

func sudoInstall(src, dest string, cause error) error {
	if _, err := exec.LookPath("sudo"); err != nil {
		return cause
	}
	out, err := exec.Command("sudo", "-n", "install", "-m", "0755", src, dest).CombinedOutput()
	if err == nil {
		return nil
	}
	return fmt.Errorf("%v; sudo install failed: %w: %s", cause, err, strings.TrimSpace(string(out)))
}

func verifySHA256(path, expected string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return err
	}
	got := hex.EncodeToString(h.Sum(nil))
	if got != strings.ToLower(strings.TrimSpace(expected)) {
		return fmt.Errorf("sha256 mismatch: got %s want %s", got, expected)
	}
	return nil
}

func removePeer(ctx context.Context, logger *slog.Logger) error {
	if p, err := exec.LookPath(peerName); err == nil {
		_ = exec.CommandContext(ctx, p, "--cron", "remove").Run()
	}
	home, _ := os.UserHomeDir()
	for _, p := range []string{
		peerConfigPath(),
		peerConfigPath() + ".sig",
		filepath.Join(home, ".codex", "auth.json"),
		filepath.Join(home, ".codex", "AGENTS.md"),
		filepath.Join(home, ".codex", "config.toml"),
		filepath.Join(home, ".codex"),
	} {
		removePath(p, logger)
	}
	if npmGlobalHas("codex-cli") {
		_ = exec.CommandContext(ctx, "npm", "uninstall", "-g", "codex-cli").Run()
	}
	removePath("/opt/codex", logger)
	removePath("/etc/cron.d/cdx-managed", logger)
	removePath(peerBinaryPath(), logger)
	return nil
}

func removePath(path string, logger *slog.Logger) {
	if path == "" {
		return
	}
	if err := os.RemoveAll(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		if _, ok := err.(*os.PathError); ok {
			if sudoRemove(path) == nil {
				return
			}
		}
		logger.Warn("peer remove skipped", "path", path, "err", err)
	}
}

func sudoRemove(path string) error {
	if _, err := exec.LookPath("sudo"); err != nil {
		return err
	}
	return exec.Command("sudo", "-n", "rm", "-rf", path).Run()
}

func npmGlobalHas(pkg string) bool {
	if _, err := exec.LookPath("npm"); err != nil {
		return false
	}
	return exec.Command("npm", "ls", "-g", "--depth=0", pkg).Run() == nil
}
