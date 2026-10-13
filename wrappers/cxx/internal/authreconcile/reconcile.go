// Package authreconcile implements an explicit, read-first operator recovery.
// It never replays an upload or reserves a provider account.
package authreconcile

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/accountpool"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/claude"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/codex"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/communicator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
)

type serverAuth struct {
	Engine       string          `json:"engine"`
	AccountID    int64           `json:"account_id"`
	Verification string          `json:"verification_state"`
	Digest       string          `json:"canonical_digest"`
	LegacyDigest string          `json:"digest"`
	Generation   int64           `json:"canonical_generation"`
	LastRefresh  string          `json:"canonical_last_refresh"`
	Auth         json.RawMessage `json:"auth"`
	Host         *struct {
		Secure *bool `json:"secure"`
	} `json:"host,omitempty"`
}

// Report contains identifiers and paths only, never credential material.
type Report struct {
	Engine                 string `json:"engine"`
	Server                 string `json:"server"`
	AccountID              int64  `json:"account_id"`
	SessionID              string `json:"session_id,omitempty"`
	InactiveSessionOmitted bool   `json:"inactive_session_omitted,omitempty"`
	LocalGeneration        string `json:"local_generation"`
	PendingGeneration      string `json:"pending_generation"`
	ServerAccountID        int64  `json:"server_account_id"`
	ServerDigest           string `json:"server_digest"`
	ServerGeneration       int64  `json:"server_generation"`
	Verification           string `json:"verification_state"`
	Reason                 string `json:"reason"`
	Conflict               string `json:"conflict,omitempty"`
	Backup                 string `json:"backup,omitempty"`
	Adopted                bool   `json:"adopted"`
	AdoptedGeneration      string `json:"adopted_generation,omitempty"`
}

type backend struct {
	path   string
	secure bool
	active func() (bool, error)
	apply  func(context.Context, serverAuth, string) (string, bool, error)
	logout func(context.Context) (bool, error)
	usable func(json.RawMessage) bool
}
type transaction struct {
	backend  backend
	readback func(context.Context, int64, string) (serverAuth, error)
	backup   func(string, []byte) (string, error)
	binding  func() int64
}

func Command(ctx context.Context, cfg *config.Config, args []string, stdout, stderr io.Writer) int {
	accept := false
	if len(args) == 1 && args[0] == "--accept-server" {
		accept = true
	} else if len(args) != 0 {
		fmt.Fprintln(stderr, "usage: auth-reconcile [--accept-server]")
		return 2
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	b, err := forEngine(cfg)
	if err != nil {
		fmt.Fprintln(stderr, "auth-reconcile:", err)
		return 1
	}
	release, err := communicator.RecoveryFence(ctx, cfg.Orchestrator.BaseURL, cfg.Engine, b.path)
	if err != nil {
		fmt.Fprintln(stderr, "auth-reconcile: transaction fence unavailable")
		return 1
	}
	defer release()
	opts := orchestrator.Options{BaseURL: cfg.Orchestrator.BaseURL, APIKey: cfg.Orchestrator.APIKey, AllowInsecure: cfg.Orchestrator.AllowInsecure, Timeout: 15 * time.Second}
	if cfg.Orchestrator.CABundlePath != nil {
		opts.CABundlePath = *cfg.Orchestrator.CABundlePath
	}
	client, err := orchestrator.New(opts)
	if err != nil {
		fmt.Fprintln(stderr, "auth-reconcile: transport unavailable")
		return 1
	}
	// Deliberate recovery must not start an owner whose workers synchronize
	// content/auth. Retain the signed client's API key, CA and TLS policy;
	// use its direct transport only for this explicit readback command.
	direct, ok := communicator.Direct(client.HTTP.Transport)
	if !ok {
		fmt.Fprintln(stderr, "auth-reconcile: direct readback transport unavailable")
		return 1
	}
	client.HTTP.Transport = direct
	defer direct.CloseIdleConnections()
	tx := transaction{backend: b, backup: saveBackup, binding: func() int64 { id, _ := accountpool.Load(cfg.Engine, b.path, client.BaseURL).Binding(); return id }}
	tx.readback = func(ctx context.Context, account int64, session string) (serverAuth, error) {
		return readback(ctx, client, cfg.Engine, account, session)
	}
	report, err := tx.run(ctx, cfg.Engine, os.Getenv("CXX_PROVIDER_SESSION_ID"), accept)
	if parsed, e := url.Parse(client.BaseURL); e == nil {
		report.Server = parsed.Host
	}
	if json.NewEncoder(stdout).Encode(report) != nil {
		return 1
	}
	if err != nil {
		fmt.Fprintln(stderr, "auth-reconcile:", err)
		return 1
	}
	if report.Adopted {
		fmt.Fprintln(stderr, "Adopted server credentials; interrupted upload remains unacknowledged. Local backup:", report.Backup)
	} else {
		fmt.Fprintf(stderr, "Inspection only (%s); credentials and pending marker retained.\n", report.Reason)
		if report.Reason == "explicit_choice_required" {
			fmt.Fprintln(stderr, "Use auth-reconcile --accept-server to choose verified server credentials for the same account with a local backup.")
		}
	}
	return 0
}

func forEngine(cfg *config.Config) (backend, error) {
	if cfg == nil {
		return backend{}, errors.New("signed config required")
	}
	if cfg.EngineSuspended(cfg.Engine) {
		return backend{}, errors.New("engine is suspended; recovery refused")
	}
	b := backend{secure: cfg.Host.Secure}
	var err error
	switch cfg.Engine {
	case "codex":
		if err = codex.GuardFQDN(cfg); err != nil {
			return b, err
		}
		b.path, err = codex.AuthPath()
		b.active = codex.HasActiveAuthChild
		b.logout = codex.LogoutIntentActiveContext
		b.usable = func(raw json.RawMessage) bool { return codex.IsValidAuthPayload(raw) }
		b.apply = func(ctx context.Context, s serverAuth, generation string) (string, bool, error) {
			out, err := codex.AdoptAuthForExplicitRecovery(ctx, s.Auth, s.Verification, codex.AuthGeneration{Exists: true, Digest: generation})
			return digest(s.Auth), out.Written, err
		}
	case "claude":
		if err = claude.GuardFQDN(cfg); err != nil {
			return b, err
		}
		b.path, err = claude.AuthPath()
		b.active = claude.HasActiveAuthChild
		b.usable = claude.IsUsableAuthPayload
		b.logout = func(ctx context.Context) (bool, error) {
			state, err := claude.CurrentLogoutIntentGenerationContext(ctx)
			return state.Exists, err
		}
		b.apply = func(ctx context.Context, s serverAuth, generation string) (string, bool, error) {
			adopted, wrote, err := claude.AdoptAuthForExplicitRecovery(ctx, s.Auth, s.Digest, s.Verification, claude.AuthGeneration{Exists: true, Digest: generation})
			return adopted.Digest, wrote, err
		}
	default:
		return b, errors.New("unsupported: Grok credentials are server-owned; no local reconciliation")
	}
	return b, err
}

func (tx transaction) run(ctx context.Context, engine, session string, accept bool) (report Report, err error) {
	report.Engine = engine
	local, err := readNativeBytes(tx.backend.path)
	if err != nil {
		report.Reason = "local_auth_missing_or_unreadable"
		return report, errors.New("local credentials unavailable; no recovery write attempted")
	}
	if info, err := os.Stat(filepath.Dir(tx.backend.path)); err != nil || !owned(info) {
		report.Reason = "foreign_home"
		return report, errors.New("native auth directory is not owned by this user")
	}
	report.LocalGeneration = digest(local)
	markerPath := filepath.Join(filepath.Dir(tx.backend.path), ".cxx-communicator-pending-auth.json")
	marker, err := os.ReadFile(markerPath)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		report.Reason = "pending_marker_unreadable"
		return report, errors.New("pending marker cannot be read")
	}
	if marker != nil {
		var pending struct {
			Generation string `json:"generation"`
		}
		if json.Unmarshal(marker, &pending) != nil || !validDigest(pending.Generation) {
			report.PendingGeneration = "invalid"
		} else {
			report.PendingGeneration = pending.Generation
		}
	}
	active, err := tx.backend.active()
	if err != nil {
		report.Reason = "native_session_unknown"
		return report, errors.New("native child state could not be established")
	}
	if !active && session != "" {
		report.InactiveSessionOmitted = true
		session = ""
	}
	report.AccountID, report.SessionID = tx.binding(), session
	s, err := tx.readback(ctx, report.AccountID, session)
	if err != nil {
		report.Reason = "readback_failed"
		return report, err
	}
	if s.Digest == "" {
		s.Digest = s.LegacyDigest
	}
	report.Conflict = conflict(engine, tx.backend.path, local, s)
	report.ServerAccountID, report.ServerGeneration = s.AccountID, s.Generation
	if validDigest(s.Digest) {
		report.ServerDigest = s.Digest
	}
	s.Verification = strings.ToLower(strings.TrimSpace(s.Verification))
	if s.Verification == "verified" || s.Verification == "failed" || s.Verification == "pending" {
		report.Verification = s.Verification
	} else {
		report.Verification = "unknown"
	}
	switch {
	case s.Engine != "" && s.Engine != engine:
		report.Reason = "wrong_engine"
	case s.Verification != "verified":
		report.Reason = "server_unverified"
	case report.AccountID <= 0:
		report.Reason = "account_binding_absent"
	case s.AccountID != report.AccountID || tx.binding() != report.AccountID:
		report.Reason = "account_binding_changed"
	case !validDigest(s.Digest) || !tx.backend.usable(s.Auth):
		report.Reason = "server_credentials_missing"
	case !tx.backend.secure || s.Host != nil && s.Host.Secure != nil && !*s.Host.Secure:
		report.Reason = "insecure_host_retention_refused"
	case marker == nil:
		report.Reason = "no_pending_upload"
	case report.PendingGeneration != "invalid" && report.PendingGeneration != report.LocalGeneration:
		report.Reason = "pending_generation_obsolete"
	case active:
		report.Reason = "native_session_active"
	default:
		report.Reason = "explicit_choice_required"
	}
	if !accept {
		return report, nil
	}
	if report.Reason != "explicit_choice_required" {
		return report, fmt.Errorf("recovery refused (%s); local credentials and pending marker retained", report.Reason)
	}
	logout, err := tx.backend.logout(ctx)
	if err != nil || logout {
		report.Reason = "logout_intent"
		return report, errors.New("logout intent prevents explicit recovery; local credentials retained")
	}
	current, err := readNativeBytes(tx.backend.path)
	if err != nil || digest(current) != report.LocalGeneration {
		report.Reason = "native_generation_changed"
		return report, errors.New("native credentials changed during readback; recovery refused")
	}
	report.Backup, err = tx.backup(tx.backend.path, local)
	if err != nil {
		report.Reason = "backup_failed"
		return report, errors.New("local backup failed; credentials and pending marker retained")
	}
	if tx.binding() != report.AccountID {
		report.Reason = "account_binding_changed"
		return report, errors.New("account binding changed after backup; recovery refused")
	}
	adopted, written, err := tx.backend.apply(ctx, s, report.LocalGeneration)
	if err != nil || !written {
		report.Reason = "native_write_refused"
		return report, errors.New("guarded write refused or failed; native changes/logout kept and pending marker retained")
	}
	report.Adopted = true
	current, err = readNativeBytes(tx.backend.path)
	if err != nil {
		report.Reason = "native_generation_changed"
		return report, errors.New("native credentials disappeared after adoption; pending marker retained")
	}
	report.AdoptedGeneration = adopted
	if tx.binding() != report.AccountID {
		report.Reason = "account_binding_changed"
		return report, errors.New("account binding changed after adoption; pending marker retained")
	}
	logout, logoutErr := tx.backend.logout(ctx)
	if digest(current) != adopted || logoutErr != nil || logout {
		report.Reason = "native_generation_changed"
		return report, errors.New("native change/logout after adoption won; pending marker retained")
	}
	latest, err := os.ReadFile(markerPath)
	if err != nil || !bytes.Equal(latest, marker) {
		report.Reason = "pending_marker_changed"
		return report, errors.New("server credentials adopted but pending marker changed; it was retained")
	}
	if err = os.Remove(markerPath); err != nil {
		report.Reason = "pending_cleanup_failed"
		return report, errors.New("server credentials adopted; pending marker cleanup failed")
	}
	report.Reason = "server_credentials_adopted"
	return report, nil
}

func digest(raw []byte) string { s := sha256.Sum256(raw); return hex.EncodeToString(s[:]) }
func validDigest(s string) bool {
	if len(s) != 64 || s != strings.ToLower(s) {
		return false
	}
	_, err := hex.DecodeString(s)
	return err == nil
}
func owned(info os.FileInfo) bool {
	if info == nil {
		return false
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	return ok && int(st.Uid) == os.Geteuid()
}

func readback(ctx context.Context, c *orchestrator.Client, engine string, account int64, session string) (out serverAuth, err error) {
	body := map[string]any{"engine": engine, "command": "retrieve"}
	if account > 0 {
		body["account_id"] = account
	}
	if session != "" {
		body["session_id"] = session
	}
	raw, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, "POST", c.BaseURL+"/auth", bytes.NewReader(raw))
	if err != nil {
		return out, errors.New("readback request unavailable")
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Engine", engine)
	res, err := c.Do(ctx, req, 0)
	if err != nil {
		return out, errors.New("verified account readback unavailable; no store or lease attempted")
	}
	defer res.Body.Close()
	raw, err = io.ReadAll(io.LimitReader(res.Body, (1<<20)+1))
	if err != nil {
		return out, errors.New("readback response unavailable")
	}
	if len(raw) > 1<<20 {
		return out, errors.New("credential readback exceeds recovery read limit")
	}
	if res.StatusCode >= 400 {
		var failure struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		}
		_ = json.Unmarshal(raw, &failure)
		if session != "" && (failure.Code == "account_session_invalid" || res.StatusCode == 404 && failure.Code == "not_found" && failure.Message == "Account session not found") {
			return out, errors.New("session binding is expired or no longer exists; account readback refused and no new lease acquired")
		}
		return out, fmt.Errorf("account readback refused (HTTP %d); no new account lease was acquired", res.StatusCode)
	}
	var envelope struct {
		Data json.RawMessage `json:"data"`
	}
	_ = json.Unmarshal(raw, &envelope)
	if len(envelope.Data) > 0 && string(envelope.Data) != "null" {
		raw = envelope.Data
	}
	if json.Unmarshal(raw, &out) != nil {
		return out, errors.New("invalid credential readback response")
	}
	return out, nil
}

// Timestamp classification is diagnostic only. It never authorizes a store,
// write or fence removal; the explicit operator choice owns that decision.
func conflict(engine, path string, local []byte, server serverAuth) string {
	if engine == "codex" && codex.SameAuthCredentials(local, server.Auth) || engine == "claude" && claude.SameCredentialPair(local, server.Auth) {
		return "same_credentials"
	}
	var localDoc, serverDoc struct {
		LastRefresh string `json:"last_refresh"`
	}
	_ = json.Unmarshal(local, &localDoc)
	_ = json.Unmarshal(server.Auth, &serverDoc)
	localTime, err := time.Parse(time.RFC3339Nano, localDoc.LastRefresh)
	if err != nil {
		if info, e := os.Stat(path); e == nil {
			localTime = info.ModTime()
		}
	}
	if serverDoc.LastRefresh == "" {
		serverDoc.LastRefresh = server.LastRefresh
	}
	serverTime, err := time.Parse(time.RFC3339Nano, serverDoc.LastRefresh)
	if err != nil || localTime.IsZero() {
		return "different_credentials_unknown_order"
	}
	if serverTime.Before(localTime) {
		return "server_older"
	}
	if serverTime.Equal(localTime) {
		return "equal_stamp_different_credentials"
	}
	return "server_newer"
}

// HelpRequested keeps this diagnostic's help out of native help/session startup.
func HelpRequested(args []string) bool {
	command := ""
	help := false
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			break
		}
		if arg == "--config" || arg == "--execute" || arg == "--resume" || arg == "-r" || arg == "--cron" {
			if i+1 < len(args) {
				i++
			}
			continue
		}
		if arg == "--help" || arg == "-h" {
			help = true
			continue
		}
		if !strings.HasPrefix(arg, "-") && command == "" {
			command = arg
		}
	}
	return command == "auth-reconcile" && help
}

func PrintHelp(w io.Writer) {
	fmt.Fprintln(w, "auth-reconcile [--accept-server]")
	fmt.Fprintln(w, "Inspect a pending upload using verified account readback. --accept-server deliberately adopts the same account's server credentials after backing up local bytes; it never replays the interrupted upload.")
}

func saveBackup(authPath string, raw []byte) (path string, err error) {
	dir := filepath.Join(filepath.Dir(authPath), "auth-recovery-backups")
	if err = os.Mkdir(dir, 0700); err != nil && !errors.Is(err, os.ErrExist) {
		return "", err
	}
	info, err := os.Lstat(dir)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0077 != 0 || !owned(info) {
		return "", errors.New("backup directory is not private and owned")
	}
	f, err := os.CreateTemp(dir, "auth-*.json")
	if err != nil {
		return "", err
	}
	path = f.Name()
	completed := false
	defer func() {
		_ = f.Close()
		if !completed {
			_ = os.Remove(path)
		}
	}()
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(raw)
	}
	if err == nil {
		err = f.Sync()
	}
	if err == nil {
		err = f.Close()
	}
	if err != nil {
		return "", err
	}
	d, err := os.Open(dir)
	if err != nil {
		return "", err
	}
	err = d.Sync()
	_ = d.Close()
	if err != nil {
		return "", err
	}
	completed = true
	return path, nil
}

func readNativeBytes(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, (1<<20)+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > 1<<20 {
		return nil, errors.New("native auth exceeds recovery read limit")
	}
	return raw, nil
}
