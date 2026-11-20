package nativeengine

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"os"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/communicator"
	orchestrator "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
)

// CopyOptional snapshots a regular native config asset into a private home.
func (s *Store) CopyOptional(source, dest string) error {
	f, err := os.Open(source)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	defer f.Close()
	if info, err := f.Stat(); err != nil {
		return err
	} else if !info.Mode().IsRegular() {
		return nil
	}
	raw, err := io.ReadAll(io.LimitReader(f, (16<<20)+1))
	if err != nil {
		return err
	}
	if len(raw) > 16<<20 {
		return errors.New("native config asset exceeds snapshot limit")
	}
	return s.AtomicWrite(dest, raw, 0o600)
}

func MergeMap(dst, src map[string]any) {
	for key, value := range src {
		if nested, ok := value.(map[string]any); ok {
			target, _ := dst[key].(map[string]any)
			if target == nil {
				target = map[string]any{}
			}
			MergeMap(target, nested)
			dst[key] = target
		} else {
			dst[key] = value
		}
	}
}

func TokenDigest(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// SessionNotFound reports the server's 404 "Account session not found", which a
// connection-mode lease answers while its provider attachment is redialing.
func SessionNotFound(err error) bool {
	var httpErr *orchestrator.HTTPError
	return errors.As(err, &httpErr) && httpErr.StatusCode == http.StatusNotFound
}

// ConfirmRefresh re-checks a 404 under policy before returning it, so callers
// treat it as fatal only when it persisted.
func ConfirmRefresh(ctx context.Context, policy communicator.RecheckPolicy, call func(context.Context) error) error {
	err := call(ctx)
	if !SessionNotFound(err) {
		return err
	}
	return communicator.ConfirmNotFound(ctx, policy, call, SessionNotFound)
}

func FatalAuthError(err error) bool {
	var httpErr *orchestrator.HTTPError
	if !errors.As(err, &httpErr) {
		return false
	}
	return httpErr.StatusCode == http.StatusUnauthorized || httpErr.StatusCode == http.StatusNotFound ||
		(httpErr.StatusCode == http.StatusConflict && httpErr.Code != "communicator_outcome_unknown")
}
