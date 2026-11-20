// Package sessionnotice is the per-engine session mailbox shared by authnotice
// and contentnotice. A publisher records one current notice per engine scope;
// each local session receives it once. It stores opaque generations, never the
// changed data, and never signals or restarts native processes.
//
// The directory layout and JSON files are local state read by every
// concurrently running cxx release, so they are frozen:
//
//	~/.cache/codex-orchestrator/<Dir>/<engine>-<scope digest>/current.json
//	                                                         /<session>.seen
//	                                                         /<session>.seen.json (optional companion)
//	                                                         /<session>.delivery and .lock (flock files)
package sessionnotice

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// Header carries the fields every notice payload has.
type Header struct {
	Generation string
	Engine     string
	UpdatedAt  time.Time
}

// Mailbox describes one notice kind. T is the JSON payload stored in
// current.json.
type Mailbox[T any] struct {
	// Dir is the directory under ~/.cache/codex-orchestrator.
	Dir string
	// Label names the notice in error text, for example "auth notice".
	Label string
	// Header exposes the common fields of a payload.
	Header func(T) Header
	// Complete, when set, rejects a stored payload that lacks its data.
	Complete func(T) bool
	// Companion, when set, returns metadata committed to <session>.seen.json
	// before the plain generation ledger that older consumers read.
	Companion func(T) ([]byte, error)
	// Narrow, when set, adjusts a pending notice against the session's plain
	// ledger and companion bytes; false suppresses it.
	Narrow func(notice T, seen string, companion []byte) (T, bool)
}

// Path returns the engine-scoped mailbox directory.
func (m *Mailbox[T]) Path(engine string) (string, error) {
	if engine != "codex" && engine != "claude" && engine != "grok" && engine != "kimi" {
		return "", errors.New("unknown " + m.Label + " engine")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	scope := filepath.Join(home, "."+engine)
	if engine == "kimi" {
		scope = filepath.Join(home, ".kimi-code")
	}
	if engine == "codex" && strings.TrimSpace(os.Getenv("CODEX_HOME")) != "" {
		scope = strings.TrimSpace(os.Getenv("CODEX_HOME"))
	}
	if engine == "grok" && strings.TrimSpace(os.Getenv("GROK_HOME")) != "" {
		scope = strings.TrimSpace(os.Getenv("GROK_HOME"))
	}
	if engine == "kimi" && strings.TrimSpace(os.Getenv("KIMI_CODE_HOME")) != "" {
		scope = strings.TrimSpace(os.Getenv("KIMI_CODE_HOME"))
	}
	scope, err = filepath.Abs(scope)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256([]byte(filepath.Clean(scope)))
	return filepath.Join(home, ".cache", "codex-orchestrator", m.Dir, engine+"-"+hex.EncodeToString(digest[:8])), nil
}

// WithLock runs fn under the engine's publisher lock.
func (m *Mailbox[T]) WithLock(engine string, fn func(string) error) error {
	dir, err := m.Path(engine)
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
	// A notification is best effort. Contention must never delay token syncing,
	// a content pass or a native hook while another process publishes.
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

func (m *Mailbox[T]) read(dir string) (T, error) {
	var notice, none T
	raw, err := os.ReadFile(filepath.Join(dir, "current.json"))
	if errors.Is(err, os.ErrNotExist) {
		return notice, nil
	}
	if err != nil {
		return notice, err
	}
	if err = json.Unmarshal(raw, &notice); err != nil {
		return none, err
	}
	h := m.Header(notice)
	if len(h.Generation) != 64 || (m.Complete != nil && !m.Complete(notice)) || h.UpdatedAt.IsZero() || time.Since(h.UpdatedAt) > 24*time.Hour {
		return none, nil
	}
	return notice, nil
}

// Publish deduplicates all writers of the same exact generation. next builds
// the stored payload from the current one; it runs under the publisher lock.
// Callers validate the generation first.
func (m *Mailbox[T]) Publish(engine, generation string, next func(previous T) T) error {
	publish := func() error {
		return m.WithLock(engine, func(dir string) error {
			previous, err := m.read(dir)
			if err != nil {
				return err
			}
			if m.Header(previous).Generation == generation {
				return nil
			}
			raw, err := json.Marshal(next(previous))
			if err != nil {
				return err
			}
			return atomicWrite(filepath.Join(dir, "current.json"), raw)
		})
	}
	// A short collision with a sibling hook must not lose a publication. Bound
	// this wait so a notice can never stall auth or content processing.
	for attempt := 0; ; attempt++ {
		err := publish()
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
type Delivery[T any] struct {
	Notice  T
	ledger  string
	lock    *os.File
	mailbox *Mailbox[T]
}

func (d *Delivery[T]) Abort() {
	if d != nil && d.lock != nil {
		_ = d.lock.Close()
		d.lock = nil
	}
}

func (d *Delivery[T]) Commit() error {
	if d == nil || d.lock == nil {
		return nil
	}
	defer d.Abort()
	if d.mailbox.Companion != nil {
		raw, err := d.mailbox.Companion(d.Notice)
		if err != nil {
			return err
		}
		// Keep the original ledger readable by still-running older hooks/MCP
		// consumers. Commit the matching metadata first; a failed write leaves
		// the generation pending, while a legacy writer invalidates stale metadata.
		if err = atomicWrite(d.ledger+".json", raw); err != nil {
			return err
		}
	}
	return atomicWrite(d.ledger, []byte(d.mailbox.Header(d.Notice).Generation))
}

// Prepare lets concurrent sessions receive the same notice, but prevents
// competing hook/MCP consumers in one session from emitting it concurrently.
func (m *Mailbox[T]) Prepare(engine, session string) (*Delivery[T], error) {
	if !validSession(session) {
		return nil, errors.New("invalid " + m.Label + " session")
	}
	var result *Delivery[T]
	err := m.WithLock(engine, func(dir string) error {
		notice, err := m.read(dir)
		if err != nil || m.Header(notice).Generation == "" {
			return err
		}
		if m.Header(notice).Engine != engine {
			return errors.New(m.Label + " engine mismatch")
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
		if string(seen) == m.Header(notice).Generation {
			return nil
		}
		if m.Narrow != nil {
			companion, err := os.ReadFile(ledger + ".json")
			if err != nil {
				companion = nil
			}
			var pending bool
			if notice, pending = m.Narrow(notice, string(seen), companion); !pending {
				return nil
			}
		}
		result = &Delivery[T]{Notice: notice, ledger: ledger, lock: lock, mailbox: m}
		keepLock = true
		return nil
	})
	return result, err
}

// Prime suppresses a notice that predates this session. Later publications
// remain eligible for delivery through its prompt hook or agent MCP connection.
func (m *Mailbox[T]) Prime(engine, session string) error {
	delivery, err := m.PreparePrime(engine, session)
	if err != nil || delivery == nil {
		return err
	}
	return delivery.Commit()
}

// PreparePrime is Prime's first phase. It reads the atomically published
// baseline without the publisher lock: Prime runs before native startup and only
// writes this session's ledger. The delivery lock still fences hook/MCP
// consumers; contention fails immediately. Pinning the snapshot here means a
// publication during Commit remains pending for delivery.
func (m *Mailbox[T]) PreparePrime(engine, session string) (*Delivery[T], error) {
	if !validSession(session) {
		return nil, errors.New("invalid " + m.Label + " session")
	}
	dir, err := m.Path(engine)
	if err != nil {
		return nil, err
	}
	if err = os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	lock, err := os.OpenFile(filepath.Join(dir, session+".delivery"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	keepLock := false
	defer func() {
		if !keepLock {
			lock.Close()
		}
	}()
	if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return nil, err
	}
	notice, err := m.read(dir)
	if err != nil || m.Header(notice).Generation == "" {
		return nil, err
	}
	if m.Header(notice).Engine != engine {
		return nil, errors.New(m.Label + " engine mismatch")
	}
	keepLock = true
	return &Delivery[T]{Notice: notice, ledger: filepath.Join(dir, session+".seen"), lock: lock, mailbox: m}, nil
}
