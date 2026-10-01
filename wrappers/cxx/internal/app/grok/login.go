package grok

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/accountpool"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	native "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/grok"
	orchestrator "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
)

type pendingLogin struct {
	Version   int             `json:"version"`
	CreatedAt time.Time       `json:"created_at"`
	Auth      json.RawMessage `json:"auth"`
}

func pendingLoginPath() (string, error) {
	state, err := native.StateDir()
	return filepath.Join(state, "pending-login.json"), err
}
func clearPendingLogin() error {
	path, err := pendingLoginPath()
	if err != nil {
		return err
	}
	err = os.Remove(path)
	if os.IsNotExist(err) {
		return nil
	}
	return err
}
func readPendingLogin() (pendingLogin, error) {
	path, err := pendingLoginPath()
	if err != nil {
		return pendingLogin{}, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return pendingLogin{}, errors.New("no pending Grok login; run cgx login")
	}
	var pending pendingLogin
	if json.Unmarshal(data, &pending) != nil || pending.Version != 1 || pending.CreatedAt.IsZero() || pending.CreatedAt.After(time.Now().Add(5*time.Minute)) || time.Since(pending.CreatedAt) > 24*time.Hour {
		_ = clearPendingLogin()
		return pendingLogin{}, errors.New("pending Grok login expired; run cgx login")
	}
	return pending, nil
}
func safeAuthError(err error) string {
	var httpErr *orchestrator.HTTPError
	if errors.As(err, &httpErr) {
		return fmt.Sprintf("Grok authentication rejected (HTTP %d, %s)", httpErr.StatusCode, httpErr.Code)
	}
	if err != nil {
		return "Grok authentication upload unavailable"
	}
	return "Grok login was not accepted"
}
func uploadLogin(ctx context.Context, client *orchestrator.Client, candidate json.RawMessage) error {
	body := map[string]any{"engine": "grok", "command": "store", "auth": candidate}
	var result orchestrator.AuthRetrieveResponse
	err := client.JSON(ctx, http.MethodPost, "/auth", body, &result, 0)
	var conflict *orchestrator.HTTPError
	if errors.As(err, &conflict) && conflict.StatusCode == http.StatusConflict && conflict.Code == "grok_generation_conflict" {
		id, generation := loginConflictMetadata([]byte(conflict.Body))
		if id <= 0 || generation <= 0 {
			return errors.New("Grok login account generation unavailable")
		}
		// Metadata comes from the locked head, including fenced/expired heads.
		// Retry once; another advancement remains a conflict.
		body["account_id"], body["base_canonical_generation"] = id, generation
		err = client.JSON(ctx, http.MethodPost, "/auth", body, &result, 0)
	}
	if err != nil {
		return err
	}
	if !result.AuthCandidateAccepted() {
		return errors.New("Grok login was not accepted as canonical")
	}
	return nil
}
func validateLogin(candidate json.RawMessage) error {
	var envelope struct {
		GrokAuth map[string]struct {
			Key      string    `json:"key"`
			Mode     string    `json:"auth_mode"`
			Refresh  string    `json:"refresh_token"`
			Issuer   string    `json:"oidc_issuer"`
			ClientID string    `json:"oidc_client_id"`
			Expires  time.Time `json:"expires_at"`
		} `json:"grok_auth"`
	}
	if json.Unmarshal(candidate, &envelope) != nil {
		return errors.New("invalid Grok login credential map")
	}
	c := envelope.GrokAuth[native.OfficialScope]
	if c.Mode != "oidc" || c.Key == "" || c.Refresh == "" || !c.Expires.After(time.Now()) || (c.Issuer != "" && c.Issuer != "https://auth.x.ai") || (c.ClientID != "" && c.ClientID != native.OfficialClientID) {
		return errors.New("fresh Grok subscription OAuth login required")
	}
	return nil
}
func login(ctx context.Context, cfg *config.Config, client *orchestrator.Client, args []string, stdout, stderr io.Writer) error {
	retry := len(args) == 1 && (args[0] == "retry" || args[0] == "--retry")
	if hasArg(args, "--api-key", "--devbox") {
		return errors.New("cgx login accepts subscription OAuth only")
	}
	if retry && !cfg.Host.Secure {
		_ = clearPendingLogin()
		return errors.New("insecure hosts require a fresh cgx login")
	}
	dir, err := os.MkdirTemp("", "cgx-login-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	previous := client.Pool
	client.Pool = accountpool.Load("grok", filepath.Join(dir, "auth.json"), cfg.Orchestrator.BaseURL)
	defer func() { client.Pool = previous }()
	var pending pendingLogin
	if retry {
		pending, err = readPendingLogin()
		if err != nil {
			return err
		}
	} else {
		path, err := native.FindCLI()
		if err != nil {
			return err
		}
		env := []string{}
		for _, entry := range native.NativeEnv(os.Environ()) {
			key, _, _ := strings.Cut(entry, "=")
			if hasArg([]string{key}, "GROK_AUTH", "GROK_AUTH_PROVIDER_COMMAND", "GROK_CONFIG", "GROK_CONFIG_PATH", "GROK_API_KEY", "XAI_API_KEY", "CXX_GROK_AUTH_SOCKET") || strings.HasPrefix(key, "GROK_OIDC_") || strings.HasPrefix(key, "GROK_OAUTH2_") {
				continue
			}
			env = append(env, entry)
		}
		env = native.SetEnv(env, "GROK_HOME", dir)
		env = native.SetEnv(env, "GROK_AUTH_PATH", filepath.Join(dir, "auth.json"))
		env = native.SetEnv(env, "GROK_DISABLE_API_KEY_AUTH", "1")
		if code := execute(ctx, path, append([]string{"login"}, args...), env, stdout, stderr); code != 0 {
			return fmt.Errorf("Grok subscription login exited %d", code)
		}
		raw, err := os.ReadFile(filepath.Join(dir, "auth.json"))
		if err != nil {
			return err
		}
		created := time.Now().UTC()
		auth, err := json.Marshal(map[string]any{"last_refresh": created.Format(time.RFC3339Nano), "grok_auth": json.RawMessage(raw)})
		if err != nil {
			return err
		}
		pending = pendingLogin{Version: 1, CreatedAt: created, Auth: auth}
	}
	if err := validateLogin(pending.Auth); err != nil {
		_ = clearPendingLogin()
		return err
	}
	if err := uploadLogin(ctx, client, pending.Auth); err != nil {
		if cfg.Host.Secure {
			path, pathErr := pendingLoginPath()
			if pathErr != nil {
				return pathErr
			}
			raw, _ := json.Marshal(pending)
			if saveErr := native.AtomicWrite(path, raw, 0o600); saveErr != nil {
				return errors.New("Grok login upload and protected pending storage failed; run cgx login")
			}
			return fmt.Errorf("%s; retry this protected login with cgx login retry within 24 hours", safeAuthError(err))
		}
		_ = clearPendingLogin()
		return fmt.Errorf("%s; run a fresh cgx login", safeAuthError(err))
	}
	if err := clearPendingLogin(); err != nil {
		return errors.New("Grok login accepted; pending credential cleanup failed")
	}
	return nil
}
