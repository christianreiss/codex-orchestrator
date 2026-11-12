package libcselect

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/installspace"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
)

const policy = 1
const stateName = ".libc-selection.json"

type State struct {
	Policy    int       `json:"policy"`
	Version   string    `json:"version"`
	Request   string    `json:"request,omitempty"`
	Host      string    `json:"host"`
	Path      string    `json:"path"`
	Identity  string    `json:"identity"`
	Variant   string    `json:"variant"`
	Artifact  string    `json:"artifact,omitempty"`
	Reason    string    `json:"reason,omitempty"`
	NextCheck time.Time `json:"next_check,omitempty"`
	Failures  int       `json:"failures,omitempty"`
	Failed    bool      `json:"failed,omitempty"`
}
type forceKey struct{}

func Force(ctx context.Context) context.Context { return context.WithValue(ctx, forceKey{}, true) }

type attemptKey struct{}
type attempt struct {
	variant, artifact, path string
	version                 string
	host                    Host
}

type healthKey struct{}

// WithHealth extends convergence checks to required engine siblings.
func WithHealth(ctx context.Context, health func(string) bool) context.Context {
	return context.WithValue(ctx, healthKey{}, health)
}

type resolverKey struct{}

// WithResolver resolves aliases under the same persistent retry/selection lock.
func WithResolver(ctx context.Context, resolve func(context.Context) (string, error)) context.Context {
	return context.WithValue(ctx, resolverKey{}, resolve)
}
func Target(ctx context.Context) string {
	if a, ok := ctx.Value(attemptKey{}).(*attempt); ok {
		return a.version
	}
	return ""
}
func Requested(ctx context.Context) string {
	if a, ok := ctx.Value(attemptKey{}).(*attempt); ok {
		return a.variant
	}
	return ""
}
func Attempting(ctx context.Context) bool { return Requested(ctx) != "" }

// Publication writes evidence into the stage before the pointer can change. It
// also lets the next process recover a successful rename with a lost completion.
func Publication(ctx context.Context, path, artifact string) error {
	a, ok := ctx.Value(attemptKey{}).(*attempt)
	if !ok {
		return nil
	}
	if actual := Inspect(path); actual != Unknown && actual != a.variant {
		if a.variant == GNU {
			return Incompatible(fmt.Errorf("provider candidate is %s, expected glibc", actual))
		}
		a.variant = actual
	}
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	digest := sha256.New()
	_, err = io.Copy(digest, f)
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	artifact += "#sha256:" + hex.EncodeToString(digest.Sum(nil))
	a.path = path
	a.artifact = artifact
	s := State{Policy: policy, Version: a.version, Host: a.host.Fingerprint, Path: path, Identity: identity(path), Variant: a.variant, Artifact: artifact}
	// Receipt is beside the executable; nested native packages stay intact.
	return write(filepath.Join(filepath.Dir(path), stateName), s)
}
func identity(path string) string {
	if p, e := filepath.EvalSymlinks(path); e == nil {
		path = p
	}
	f, e := os.Stat(path)
	if e != nil {
		return ""
	}
	return fmt.Sprintf("%s:%d:%d:%o", path, f.Size(), f.ModTime().UnixNano(), f.Mode())
}
func read(path string) State {
	var s State
	b, e := os.ReadFile(path)
	if e == nil {
		_ = json.Unmarshal(b, &s)
	}
	return s
}
func write(path string, s State) error {
	b, e := json.MarshalIndent(s, "", "  ")
	if e != nil {
		return e
	}
	f, e := os.CreateTemp(filepath.Dir(path), ".libc-state-*")
	if e != nil {
		return e
	}
	defer os.Remove(f.Name())
	if e = f.Chmod(0600); e == nil {
		_, e = f.Write(b)
	}
	if e == nil {
		e = f.Sync()
	}
	if ce := f.Close(); e == nil {
		e = ce
	}
	if e != nil {
		return e
	}
	if e = os.Rename(f.Name(), path); e != nil {
		return e
	}
	d, e := os.Open(filepath.Dir(path))
	if e != nil {
		return e
	}
	defer d.Close()
	return d.Sync()
}
func matches(s State, version string, h Host, path string) bool {
	return s.Policy == policy && s.Version == version && s.Host == h.Fingerprint && s.Path == path && (s.Identity != "" || (s.Failed && path == "")) && s.Identity == identity(path)
}

// Status is local diagnostic evidence, never a reason to skip live version checks.
func Status(root string) State { return read(filepath.Join(root, stateName)) }

// Run serializes variant reconciliation across processes. Install retains each
// engine's existing install lock and staged publication/retention contract.
func Run(ctx context.Context, root, version string, current func() (string, string), install func(context.Context) error, logger *slog.Logger) (retErr error) {
	if runtime.GOOS != "linux" {
		return install(ctx)
	}
	ctx, release, err := installspace.Lock(ctx)
	if err != nil {
		return err
	}
	defer release()
	if err = os.MkdirAll(root, 0700); err != nil {
		return err
	}
	lock, err := ipc.TryAcquireExclusivePath(filepath.Join(root, ".libc-reconcile.lock"))
	if err != nil {
		return err
	}
	defer lock.Release()
	if logger == nil {
		logger = slog.Default()
	}
	host := Detect(ctx)
	path, installed := current()
	old := Status(root)
	now := time.Now()
	requested := version
	resolver, hasResolver := ctx.Value(resolverKey{}).(func(context.Context) (string, error))
	health, ok := ctx.Value(healthKey{}).(func(string) bool)
	if !ok {
		health = func(string) bool { return true }
	}
	persist := func(s State) error {
		s.Request = requested
		if hasResolver && !s.Failed && s.NextCheck.IsZero() {
			s.NextCheck = now.Add(24 * time.Hour)
		}
		return write(filepath.Join(root, stateName), s)
	}
	forced, _ := ctx.Value(forceKey{}).(bool)
	waitLimit := 24 * time.Hour
	if old.Failed {
		waitLimit = 6 * time.Hour
	}
	freshDeadline := !old.NextCheck.IsZero() && now.Before(old.NextCheck) && old.NextCheck.Sub(now) <= waitLimit
	stableGNU := !old.Failed && old.Variant == GNU && old.NextCheck.IsZero() && !hasResolver
	keyVersion := version
	if hasResolver && old.Request == requested {
		keyVersion = old.Version
	}
	if matches(old, keyVersion, host, path) && (old.Failed || (installed == keyVersion && health(path))) && !forced && (freshDeadline || stableGNU) {
		logger.Debug("engine libc selection", "variant", old.Variant, "reason", old.Reason, "next_check", old.NextCheck)
		if old.Failed {
			return fmt.Errorf("engine libc reconciliation deferred until %s: %s", old.NextCheck.Format(time.RFC3339), old.Reason)
		}
		return nil
	}
	defer func() {
		if retErr != nil && ctx.Err() == nil {
			failures := 1
			if matches(old, old.Version, host, path) && (old.Request == requested || (old.Request == "" && old.Version == requested)) {
				failures = 2
				if old.Failures >= 2 {
					failures = 3
				}
			}
			delay := 15 * time.Minute
			if failures == 2 {
				delay = time.Hour
			}
			if failures >= 3 {
				delay = 6 * time.Hour
			}
			s := State{Policy: policy, Version: version, Host: host.Fingerprint, Path: path, Identity: identity(path), Variant: Inspect(path), Failed: true, Failures: failures, Reason: "candidate resolution, installation or verification failed", NextCheck: now.Add(delay)}
			if e := persist(s); e != nil {
				retErr = errors.Join(retErr, e)
			}
		}
	}()
	if hasResolver {
		version, err = resolver(ctx)
		if err != nil {
			return err
		}
		if version == "" {
			return errors.New("provider alias resolved to an empty version")
		}
	}
	receipt := read(filepath.Join(filepath.Dir(path), stateName))
	if (!old.Failed || !matches(old, version, host, path)) && installed == version && health(path) && matches(receipt, version, host, path) && receipt.Variant == GNU && !forced {
		return persist(receipt)
	}
	reason := ""
	variants := []string{Musl}
	if host.GNU {
		variants = []string{GNU, Musl}
	} else {
		reason = "no usable glibc loader"
	}
	for _, variant := range variants {
		// A previously verified fallback can be kept after rechecking GNU, without
		// downloading or republishing the identical musl installation every day.
		known := Inspect(path)
		if matches(receipt, version, host, path) {
			known = receipt.Variant
		}
		if installed == version && health(path) && known == variant && (variant == GNU || reason != "") {
			s := State{Policy: policy, Version: version, Host: host.Fingerprint, Path: path, Identity: identity(path), Variant: known, Artifact: receipt.Artifact, Reason: reason}
			if known != GNU {
				s.NextCheck = now.Add(24 * time.Hour)
			}
			return persist(s)
		}
		a := &attempt{variant: variant, version: version, host: host}
		err = install(context.WithValue(ctx, attemptKey{}, a))
		if err != nil {
			if variant == GNU && MayFallback(err) {
				reason = err.Error()
				continue
			}
			return err
		}
		selected, actualVersion := current()
		publishedReceipt := read(filepath.Join(filepath.Dir(selected), stateName))
		if selected == "" || selected != a.path || a.artifact == "" || actualVersion != version || !health(selected) || !matches(publishedReceipt, version, host, selected) || publishedReceipt.Variant != a.variant || publishedReceipt.Artifact != a.artifact {
			return errors.New("published engine version did not converge")
		}
		s := State{Policy: policy, Version: version, Host: host.Fingerprint, Path: selected, Identity: identity(selected), Variant: a.variant, Artifact: a.artifact, Reason: reason}
		if a.variant == GNU {
			s.Reason = ""
		}
		if a.variant != GNU {
			s.NextCheck = now.Add(24 * time.Hour)
		}
		if err = persist(s); err != nil {
			return err
		}
		logger.Info("engine libc selection ready", "version", version, "variant", variant, "reason", reason, "next_check", s.NextCheck)
		return nil
	}
	return ErrUnavailable
}

// EngineEnabled limits this policy to the three explicitly supported providers.
func EngineEnabled(engine string) bool {
	return runtime.GOOS == "linux" && (engine == "codex" || engine == "claude" || engine == "grok")
}
func EngineRoot(engine string) string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".cxx", "engines", engine)
}

// Description is read-only and does not invoke a provider or contact a registry.
func Description(engine string) string {
	if !EngineEnabled(engine) {
		return ""
	}
	s := Status(EngineRoot(engine))
	if s.Policy != policy || s.Identity == "" || s.Identity != identity(s.Path) {
		return ""
	}
	text := "libc: " + s.Variant
	if s.Reason != "" {
		// Not an error: the glibc build is optional and musl is the supported fallback.
		text += " (fallback, not an error: " + strings.TrimPrefix(s.Reason, ErrUnavailable.Error()+": ") + ")"
	}
	if !s.NextCheck.IsZero() {
		text += "; next check " + s.NextCheck.UTC().Format(time.RFC3339)
	}
	return text
}
