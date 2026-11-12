package kimi

import (
	"context"
	"encoding/hex"
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
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
	native "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/kimi"
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
		return pendingLogin{}, errors.New("no pending Kimi login; run ckx login")
	}
	var pending pendingLogin
	if json.Unmarshal(data, &pending) != nil || pending.Version != 1 || pending.CreatedAt.IsZero() || pending.CreatedAt.After(time.Now().Add(5*time.Minute)) || time.Since(pending.CreatedAt) > 24*time.Hour {
		_ = clearPendingLogin()
		return pendingLogin{}, errors.New("pending Kimi login expired; run ckx login")
	}
	return pending, nil
}
func safeAuthError(err error) string {
	var httpErr *orchestrator.HTTPError
	if errors.As(err, &httpErr) {
		return fmt.Sprintf("Kimi authentication rejected (HTTP %d, %s)", httpErr.StatusCode, httpErr.Code)
	}
	if err != nil {
		return "Kimi authentication upload unavailable"
	}
	return "Kimi login was not accepted"
}
func uploadLogin(ctx context.Context, client *orchestrator.Client, candidate json.RawMessage) error {
	body := map[string]any{"engine": "kimi", "command": "store", "auth": candidate}
	var result orchestrator.AuthRetrieveResponse
	err := client.JSON(ctx, http.MethodPost, "/auth", body, &result, 0)
	var conflict *orchestrator.HTTPError
	if errors.As(err, &conflict) && conflict.StatusCode == http.StatusConflict && conflict.Code == "kimi_generation_conflict" {
		id, generation := loginConflictMetadata([]byte(conflict.Body))
		if id <= 0 || generation <= 0 {
			return errors.New("Kimi login account generation unavailable")
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
		return errors.New("Kimi login was not accepted as canonical")
	}
	return nil
}
func validateLogin(candidate json.RawMessage) error {
	var envelope native.AuthEnvelope
	if json.Unmarshal(candidate, &envelope) != nil {
		return errors.New("invalid Kimi canonical login")
	}
	c := envelope.KimiCode
	if c.Key == "" || c.RefreshToken == "" || c.ExpiresAt <= time.Now().Unix() || c.Scope != "kimi-code" || c.TokenType != "Bearer" || !validDeviceID(envelope.DeviceID) || envelope.OAuthHost != "https://auth.kimi.com" || envelope.BaseURL != "https://api.kimi.com/coding/v1" {
		return errors.New("fresh Kimi subscription device login required")
	}
	return nil
}
func login(ctx context.Context, cfg *config.Config, client *orchestrator.Client, args []string, stdout, stderr io.Writer) error {
	if region := nativeArgument(args, "--region"); region != "" && region != "mainland-cn" {
		return errors.New("fleet Kimi login uses the mainland-cn auth.kimi.com contract")
	}
	retry := len(args) == 1 && (args[0] == "retry" || args[0] == "--retry")
	if nativeAnyFlag(args, "--api-key", "--devbox") {
		return errors.New("ckx login accepts subscription OAuth only")
	}
	if retry && !cfg.Host.Secure {
		_ = clearPendingLogin()
		return errors.New("insecure hosts require a fresh ckx login")
	}
	home, err := native.Home()
	if err != nil {
		return err
	}
	activity, err := ipc.TryAcquireSharedPath(filepath.Join(home, ".ckx-sessions.lock"))
	if err != nil {
		return err
	}
	defer activity.Release()
	if err := native.SweepPrivateDirectories(); err != nil {
		return err
	}
	dir, err := os.MkdirTemp("", "ckx-login-")
	if err != nil {
		return err
	}
	private, err := native.GuardPrivateDirectory(dir, activity)
	if err != nil {
		return err
	}
	defer private.Close()
	previous := client.Pool
	client.Pool = accountpool.Load("kimi", filepath.Join(dir, "auth.json"), cfg.Orchestrator.BaseURL)
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
			if hasArg([]string{key}, "KIMI_AUTH", "KIMI_AUTH_PROVIDER_COMMAND", "KIMI_CONFIG", "KIMI_CONFIG_PATH", "KIMI_API_KEY", "CXX_KIMI_AUTH_SOCKET") || strings.HasPrefix(key, "KIMI_OIDC_") || strings.HasPrefix(key, "KIMI_OAUTH2_") {
				continue
			}
			env = append(env, entry)
		}
		env = native.SetEnv(env, "KIMI_CODE_HOME", dir)
		env = native.SetEnv(env, "KIMI_CODE_OAUTH_HOST", "https://auth.kimi.com")
		env = native.SetEnv(env, "KIMI_CODE_BASE_URL", "https://api.kimi.com/coding/v1")
		if code := execute(ctx, path, append([]string{"login"}, args...), env, stdout, stderr, private); code != 0 {
			return fmt.Errorf("Kimi subscription login exited %d", code)
		}
		raw, err := os.ReadFile(filepath.Join(dir, "credentials", "kimi-code.json"))
		if err != nil {
			return err
		}
		created := time.Now().UTC()
		device, err := os.ReadFile(filepath.Join(dir, "device_id"))
		if err != nil {
			return err
		}
		auth, err := json.Marshal(map[string]any{"last_refresh": created.Format(time.RFC3339Nano), "kimi_code": json.RawMessage(raw), "device_id": strings.TrimSpace(string(device)), "oauth_host": "https://auth.kimi.com", "base_url": "https://api.kimi.com/coding/v1"})
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
				return errors.New("Kimi login upload and protected pending storage failed; run ckx login")
			}
			return fmt.Errorf("%s; retry this protected login with ckx login retry within 24 hours", safeAuthError(err))
		}
		_ = clearPendingLogin()
		return fmt.Errorf("%s; run a fresh ckx login", safeAuthError(err))
	}
	if err := clearPendingLogin(); err != nil {
		return errors.New("Kimi login accepted; pending credential cleanup failed")
	}
	return nil
}

func validDeviceID(value string) bool {
	raw, err := hex.DecodeString(value)
	return err == nil && len(raw) == 16
}
