// Package authnotice carries credential-change notices to active local sessions.
// It stores opaque generations, never credentials, and never signals or restarts
// native processes. Those clients reload disk credentials on their own auth paths.
package authnotice

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

type Notice struct {
	Generation string    `json:"generation"`
	Engine     string    `json:"engine"`
	UpdatedAt  time.Time `json:"updated_at"`
}

func (n Notice) Message() string {
	name, command := "Codex", "cdx"
	if n.Engine == "claude" {
		name, command = "Claude", "clx"
	}
	return fmt.Sprintf("Managed %s credentials were updated on disk. The native client can reload them during token refresh or authentication recovery. If authentication remains blocked, resume the session through %s to load the current credentials.", name, command)
}

func paths(engine string) (string, error) {
	if engine != "codex" && engine != "claude" {
		return "", errors.New("unknown auth notice engine")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	scope := filepath.Join(home, "."+engine)
	if engine == "codex" && strings.TrimSpace(os.Getenv("CODEX_HOME")) != "" {
		scope = strings.TrimSpace(os.Getenv("CODEX_HOME"))
	}
	scope, err = filepath.Abs(scope)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256([]byte(filepath.Clean(scope)))
	return filepath.Join(home, ".cache", "codex-orchestrator", "auth-notices", engine+"-"+hex.EncodeToString(digest[:8])), nil
}

func withLock(engine string, fn func(string) error) error {
	dir, err := paths(engine)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	f, err := os.OpenFile(filepath.Join(dir, ".lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	// A notification is best effort. Contention must never delay token syncing
	// or block a native hook while another process publishes the same event.
	if err = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return err
	}
	defer syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
	return fn(dir)
}

func atomicWrite(path string, raw []byte) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".notice-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(raw); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}

func read(dir string) (Notice, error) {
	var notice Notice
	raw, err := os.ReadFile(filepath.Join(dir, "current.json"))
	if errors.Is(err, os.ErrNotExist) {
		return notice, nil
	}
	if err != nil {
		return notice, err
	}
	if err = json.Unmarshal(raw, &notice); err != nil {
		return Notice{}, err
	}
	if len(notice.Generation) != 64 || notice.UpdatedAt.IsZero() || time.Since(notice.UpdatedAt) > 24*time.Hour {
		return Notice{}, nil
	}
	return notice, nil
}

// Publish deduplicates all writers of the same exact adopted generation.
func Publish(engine, generation string) error {
	decoded, err := hex.DecodeString(generation)
	if err != nil || len(decoded) != sha256.Size {
		return errors.New("invalid auth notice generation")
	}
	publish := func() error {
		return withLock(engine, func(dir string) error {
			previous, err := read(dir)
			if err != nil {
				return err
			}
			if previous.Generation == generation {
				return nil
			}
			raw, err := json.Marshal(Notice{Generation: generation, Engine: engine, UpdatedAt: time.Now().UTC()})
			if err != nil {
				return err
			}
			return atomicWrite(filepath.Join(dir, "current.json"), raw)
		})
	}
	// A short collision with a sibling hook must not lose an adopted generation.
	// Bound this wait so a notice can never stall auth processing indefinitely.
	for attempt := 0; ; attempt++ {
		err = publish()
		if attempt >= 25 || !(errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN)) {
			return err
		}
		time.Sleep(4 * time.Millisecond)
	}
}

func validSession(session string) bool {
	if len(session) == 0 || len(session) > 128 {
		return false
	}
	for _, r := range session {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-') {
			return false
		}
	}
	return true
}

// Delivery reserves one session's next notice while it is being written. It
// holds no publisher lock and must be committed only after output succeeds.
type Delivery struct {
	Notice Notice
	ledger string
	lock   *os.File
}

func (d *Delivery) Abort() {
	if d != nil && d.lock != nil {
		_ = d.lock.Close()
		d.lock = nil
	}
}

func (d *Delivery) Commit() error {
	if d == nil || d.lock == nil {
		return nil
	}
	defer d.Abort()
	return atomicWrite(d.ledger, []byte(d.Notice.Generation))
}

// Prepare allows concurrent sessions to receive the same change, but prevents
// competing hook/MCP consumers in one session from emitting it concurrently.
func Prepare(engine, session string) (*Delivery, error) {
	if !validSession(session) {
		return nil, errors.New("invalid auth notice session")
	}
	var result *Delivery
	err := withLock(engine, func(dir string) error {
		notice, err := read(dir)
		if err != nil || notice.Generation == "" {
			return err
		}
		if notice.Engine != engine {
			return errors.New("auth notice engine mismatch")
		}
		ledger := filepath.Join(dir, session+".seen")
		lock, err := os.OpenFile(filepath.Join(dir, session+".delivery"), os.O_CREATE|os.O_RDWR, 0o600)
		if err != nil {
			return err
		}
		if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
			lock.Close()
			return err
		}
		keepLock := false
		defer func() {
			if !keepLock {
				lock.Close()
			}
		}()
		seen, err := os.ReadFile(ledger)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if string(seen) == notice.Generation {
			return nil
		}
		result = &Delivery{Notice: notice, ledger: ledger, lock: lock}
		keepLock = true
		return nil
	})
	return result, err
}

func Consume(engine, session string) (*Notice, error) {
	delivery, err := Prepare(engine, session)
	if err != nil || delivery == nil {
		return nil, err
	}
	if err = delivery.Commit(); err != nil {
		return nil, err
	}
	return &delivery.Notice, nil
}

// Prime suppresses a notice that predates this session. Later updates remain
// eligible for delivery through its prompt hook or agent MCP connection.
func Prime(engine, session string) error { _, err := Consume(engine, session); return err }
