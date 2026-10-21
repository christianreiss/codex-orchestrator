// Package contentnotice tells active local sessions that fleet-managed content
// changed on disk after they started. Native clients read instructions, settings
// and the Skill list at launch, so a pushed content pass alone never reaches a
// model that is already running. Like authnotice it stores opaque generations,
// never content, and never signals or restarts native processes.
package contentnotice

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"
)

// Content kinds a pass can change. Instructions and Skills can be picked up by
// the running model; everything else takes effect on the next launch.
const (
	KindInstructions = "instructions"
	KindSkills       = "skills"
	KindConfig       = "config"
)

type Notice struct {
	Generation   string    `json:"generation"`
	Engine       string    `json:"engine"`
	Kinds        []string  `json:"kinds"`
	Digests      Snapshot  `json:"digests,omitempty"`
	Instructions string    `json:"instructions,omitempty"`
	UpdatedAt    time.Time `json:"updated_at"`
}

func (n Notice) has(kind string) bool {
	for _, k := range n.Kinds {
		if k == kind {
			return true
		}
	}
	return false
}

func (n Notice) Message() string {
	var parts []string
	var changed []string
	for _, kind := range n.Kinds {
		label := map[string]string{KindInstructions: "fleet instructions", KindSkills: "Skill catalog", KindConfig: "managed configuration"}[kind]
		if label == "" {
			continue
		}
		if digest := n.Digests[kind]; digest != "" {
			label += " (sha256:" + digest + ")"
		}
		changed = append(changed, label)
	}
	if n.Generation != "" {
		parts = append(parts, "Fleet content generation sha256:"+n.Generation+". Changed: "+strings.Join(changed, ", ")+".")
	}
	if n.has(KindInstructions) {
		file := n.Instructions
		if file == "" {
			file = map[string]string{"codex": "~/.codex/AGENTS.md", "claude": "~/.claude/CLAUDE.md", "grok": "~/.grok/AGENTS.md"}[n.Engine]
		}
		parts = append(parts, "The fleet instructions in "+file+" changed since this session's last notice. Re-read that file now; where it differs from what you loaded earlier, the file is current.")
	}
	if n.has(KindSkills) {
		if n.Engine == "grok" {
			parts = append(parts, "Fleet Skills under ~/.grok/skills changed. Re-read a Skill's SKILL.md before relying on what you loaded earlier.")
		} else {
			parts = append(parts, "Fleet Skills changed. Call skill_list again and re-read a Skill before relying on what you loaded earlier.")
		}
	}
	if n.has(KindConfig) {
		parts = append(parts, "Managed settings, MCP or native configuration also changed; those take effect on the next launch.")
	}
	return strings.Join(parts, " ")
}

func paths(engine string) (string, error) {
	if engine != "codex" && engine != "claude" && engine != "grok" {
		return "", errors.New("unknown content notice engine")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	scope := filepath.Join(home, "."+engine)
	if engine == "codex" && strings.TrimSpace(os.Getenv("CODEX_HOME")) != "" {
		scope = strings.TrimSpace(os.Getenv("CODEX_HOME"))
	}
	if engine == "grok" && strings.TrimSpace(os.Getenv("GROK_HOME")) != "" {
		scope = strings.TrimSpace(os.Getenv("GROK_HOME"))
	}
	scope, err = filepath.Abs(scope)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256([]byte(filepath.Clean(scope)))
	return filepath.Join(home, ".cache", "codex-orchestrator", "content-notices", engine+"-"+hex.EncodeToString(digest[:8])), nil
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
	// Best effort: contention must never delay a content pass or a native hook.
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
	if len(notice.Generation) != 64 || len(notice.Kinds) == 0 || notice.UpdatedAt.IsZero() || time.Since(notice.UpdatedAt) > 24*time.Hour {
		return Notice{}, nil
	}
	return notice, nil
}

// Snapshot maps a content kind to the digest of the files that carry it.
type Snapshot map[string]string

// Capture digests the named files and directory trees per kind. A missing path
// is part of the digest, so creating or removing a file counts as a change.
func Capture(kinds map[string][]string) Snapshot {
	out := Snapshot{}
	for kind, list := range kinds {
		h := sha256.New()
		for _, root := range list {
			h.Write([]byte(root + "\x00"))
			_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
				if err != nil {
					h.Write([]byte("missing\x00"))
					return nil
				}
				if !d.Type().IsRegular() {
					return nil
				}
				raw, err := os.ReadFile(path)
				if err != nil {
					return nil
				}
				sum := sha256.Sum256(raw)
				h.Write([]byte(path + "\x00" + hex.EncodeToString(sum[:]) + "\x00"))
				return nil
			})
		}
		out[kind] = hex.EncodeToString(h.Sum(nil))
	}
	return out
}

// PublishChanges publishes a notice for every kind whose digest moved between
// two snapshots of one content pass. An unchanged pass publishes nothing.
func PublishChanges(engine, instructions string, before, after Snapshot) error {
	var changed []string
	for kind, digest := range after {
		if before[kind] != digest {
			changed = append(changed, kind)
		}
	}
	if len(changed) == 0 {
		return nil
	}
	sort.Strings(changed)
	keys := make([]string, 0, len(after))
	for kind := range after {
		keys = append(keys, kind)
	}
	sort.Strings(keys)
	h := sha256.New()
	for _, kind := range keys {
		h.Write([]byte(kind + "=" + after[kind] + "\n"))
	}
	return Publish(Notice{Generation: hex.EncodeToString(h.Sum(nil)), Engine: engine, Kinds: changed, Digests: after, Instructions: instructions})
}

// Publish deduplicates all writers of the same exact content generation. A
// newer pass that lands before a session read the previous notice merges its
// kinds, so a session told only about Skills still learns of new instructions.
func Publish(notice Notice) error {
	decoded, err := hex.DecodeString(notice.Generation)
	if err != nil || len(decoded) != sha256.Size || len(notice.Kinds) == 0 {
		return errors.New("invalid content notice")
	}
	publish := func() error {
		return withLock(notice.Engine, func(dir string) error {
			previous, err := read(dir)
			if err != nil {
				return err
			}
			if previous.Generation == notice.Generation {
				return nil
			}
			next := notice
			next.Kinds = append([]string(nil), notice.Kinds...)
			for _, kind := range previous.Kinds {
				if !next.has(kind) {
					next.Kinds = append(next.Kinds, kind)
				}
			}
			sort.Strings(next.Kinds)
			next.UpdatedAt = time.Now().UTC()
			raw, err := json.Marshal(next)
			if err != nil {
				return err
			}
			return atomicWrite(filepath.Join(dir, "current.json"), raw)
		})
	}
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

type seenGeneration struct {
	Generation string   `json:"generation"`
	Digests    Snapshot `json:"digests,omitempty"`
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
	raw, err := json.Marshal(seenGeneration{Generation: d.Notice.Generation, Digests: d.Notice.Digests})
	if err != nil {
		return err
	}
	// Keep the original ledger readable by still-running older hooks/MCP
	// consumers. Commit the matching metadata first; a failed write leaves
	// the generation pending, while a legacy writer invalidates stale metadata.
	if err = atomicWrite(d.ledger+".json", raw); err != nil {
		return err
	}
	return atomicWrite(d.ledger, []byte(d.Notice.Generation))
}

// Prepare lets concurrent sessions receive the same change, but prevents
// competing hook/MCP consumers in one session from emitting it twice.
func Prepare(engine, session string) (*Delivery, error) {
	if !validSession(session) {
		return nil, errors.New("invalid content notice session")
	}
	var result *Delivery
	err := withLock(engine, func(dir string) error {
		notice, err := read(dir)
		if err != nil || notice.Generation == "" {
			return err
		}
		if notice.Engine != engine {
			return errors.New("content notice engine mismatch")
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
		var previous seenGeneration
		if raw, err := os.ReadFile(ledger + ".json"); err == nil {
			_ = json.Unmarshal(raw, &previous)
		}
		if previous.Generation != string(seen) {
			// Older consumers record no category metadata. Conservatively emit
			// one full notice rather than relying on stale companion digests.
			previous = seenGeneration{}
		}
		if len(previous.Digests) > 0 && len(notice.Digests) > 0 {
			var changed []string
			for _, kind := range notice.Kinds {
				if previous.Digests[kind] != notice.Digests[kind] {
					changed = append(changed, kind)
				}
			}
			if len(changed) == 0 {
				return nil
			}
			notice.Kinds = changed
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

// Prime suppresses a notice that predates this session: it launched with the
// content already on disk. Later passes remain eligible for delivery.
func Prime(engine, session string) error {
	delivery, err := preparePrime(engine, session)
	if err != nil || delivery == nil {
		return err
	}
	return delivery.Commit()
}

// Read the atomically published baseline without the publisher lock. Prime runs
// before native startup and only writes this session's ledger. The delivery lock
// still fences hook/MCP consumers; contention fails immediately. Pinning the
// snapshot here means a publication during Commit remains pending for delivery.
func preparePrime(engine, session string) (*Delivery, error) {
	if !validSession(session) {
		return nil, errors.New("invalid content notice session")
	}
	dir, err := paths(engine)
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
	notice, err := read(dir)
	if err != nil || notice.Generation == "" {
		return nil, err
	}
	if notice.Engine != engine {
		return nil, errors.New("content notice engine mismatch")
	}
	keepLock = true
	return &Delivery{Notice: notice, ledger: filepath.Join(dir, session+".seen"), lock: lock}, nil
}
