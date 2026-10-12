// Package rebootresume implements a host-wide, at-most-once reboot handoff.
// A consumed record is never retried, even if the process dies before exec.
package rebootresume

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
)

var uuid = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

const CronMarker = "# cxx-reboot-resume: one use\n"

type Record struct {
	ID            string    `json:"request_id"`
	Engine        string    `json:"engine"`
	NativeID      string    `json:"native_session_id"`
	SessionID     string    `json:"session_id"`
	Address       string    `json:"address"`
	BootID        string    `json:"boot_id"`
	ResumeBootID  string    `json:"resume_boot_id,omitempty"`
	Reason        string    `json:"reason"`
	Continuation  string    `json:"continuation"`
	UID           uint32    `json:"uid"`
	GID           uint32    `json:"gid"`
	Home          string    `json:"home"`
	Cwd           string    `json:"cwd"`
	Executable    string    `json:"executable"`
	Environment   []string  `json:"environment,omitempty"`
	State         string    `json:"state"`
	ExecutionMode string    `json:"execution_mode,omitempty"`
	TmuxSession   string    `json:"tmux_session,omitempty"`
	AttachCommand string    `json:"attach_command,omitempty"`
	Error         string    `json:"error,omitempty"`
	CreatedAt     time.Time `json:"created_at"`
}

func (r Record) Validate() error {
	if !uuid.MatchString(r.ID) || !uuid.MatchString(r.NativeID) || !uuid.MatchString(r.SessionID) || !uuid.MatchString(r.BootID) || !uuid.MatchString(strings.TrimPrefix(r.Address, "agent:")) {
		return errors.New("canonical request, session, agent and boot UUIDs required")
	}
	if r.Engine != "codex" && r.Engine != "claude" && r.Engine != "grok" {
		return errors.New("unsupported engine")
	}
	for _, p := range []string{r.Home, r.Cwd, r.Executable} {
		if !filepath.IsAbs(p) || strings.ContainsAny(p, "\n\r\x00%") {
			return errors.New("absolute paths without control characters or cron escapes required")
		}
	}
	if strings.TrimSpace(r.Reason) == "" || len(r.Reason) > 1000 || strings.TrimSpace(r.Continuation) == "" || len(r.Continuation) > 32*1024 {
		return errors.New("reason and continuation required (1000 / 32768 bytes maximum)")
	}
	return nil
}

type Journal struct{ Dir, Cron string }

func System() Journal {
	return Journal{Dir: "/var/lib/cxx/reboot-resume", Cron: "/etc/cron.d/cxx-reboot-resume"}
}
func (j Journal) Lock() (*ipc.Lock, error) {
	if err := os.MkdirAll(j.Dir, 0700); err != nil {
		return nil, err
	}
	info, err := os.Lstat(j.Dir)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() || info.Mode().Perm()&0077 != 0 {
		return nil, errors.New("reboot journal must be a private directory, not a symlink")
	}
	if err := syncDir(filepath.Dir(j.Dir)); err != nil {
		return nil, err
	}
	return ipc.TryAcquireExclusivePath(filepath.Join(j.Dir, "lock"))
}
func (j Journal) path(id string) string { return filepath.Join(j.Dir, id+".json") }
func (j Journal) Read(id string) (*Record, error) {
	if !uuid.MatchString(id) {
		return nil, errors.New("canonical request UUID required")
	}
	b, err := os.ReadFile(j.path(id))
	if err != nil {
		return nil, err
	}
	var r Record
	if err = json.Unmarshal(b, &r); err != nil {
		return nil, err
	}
	if err = r.Validate(); err != nil {
		return nil, err
	}
	if r.ID != id {
		return nil, errors.New("journal identity mismatch")
	}
	return &r, nil
}
func (j Journal) List() ([]Record, error) {
	entries, err := os.ReadDir(j.Dir)
	if errors.Is(err, os.ErrNotExist) {
		return []Record{}, nil
	}
	if err != nil {
		return nil, err
	}
	out := []Record{}
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".json") {
			r, err := j.Read(strings.TrimSuffix(e.Name(), ".json"))
			if err != nil {
				return nil, err
			}
			out = append(out, *r)
		}
	}
	return out, nil
}
func syncDir(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}
func durable(path string, b []byte, mode os.FileMode) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".reboot-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	defer f.Close()
	if err = f.Chmod(mode); err != nil {
		return err
	}
	if _, err = f.Write(b); err != nil {
		return err
	}
	if err = f.Sync(); err != nil {
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	if err = os.Rename(f.Name(), path); err != nil {
		return err
	}
	return syncDir(filepath.Dir(path))
}
func (j Journal) Save(r *Record) error {
	b, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	return durable(j.path(r.ID), b, 0600)
}
func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'" }
func (j Journal) cronBody(r *Record) string {
	return CronMarker + "SHELL=/bin/sh\nPATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n@reboot root " + shellQuote(r.Executable) + " reboot _boot --id " + r.ID + "\n"
}

// Stage requires the host lock. Existing records, including failures, are kept
// as audit evidence. A consumed native transcript can never arm another job.
func (j Journal) Stage(r *Record) error {
	if err := r.Validate(); err != nil {
		return err
	}
	rows, err := j.List()
	if err != nil {
		return err
	}
	for _, old := range rows {
		if old.ID == r.ID {
			candidate := *r
			candidate.State = old.State
			candidate.CreatedAt = old.CreatedAt
			candidate.Error = old.Error
			candidate.ResumeBootID = old.ResumeBootID
			a, _ := json.Marshal(candidate)
			b, _ := json.Marshal(old)
			if string(a) != string(b) {
				return errors.New("request ID reused with different input")
			}
			if old.State != "prepared" && old.State != "armed" {
				return errors.New("request already consumed or terminal")
			}
			raw, err := os.ReadFile(j.Cron)
			if errors.Is(err, os.ErrNotExist) && old.State == "prepared" {
				return durable(j.Cron, []byte(j.cronBody(&old)), 0644)
			}
			if err != nil {
				return err
			}
			if string(raw) != j.cronBody(&old) {
				return errors.New("cron readback mismatch")
			}
			return nil
		}
		if old.Engine == r.Engine && old.NativeID == r.NativeID && old.ResumeBootID != "" {
			return errors.New("this native session already consumed a reboot; automatic rearming is forbidden")
		}
		if old.State == "prepared" || old.State == "armed" || old.State == "consumed" || old.State == "running" {
			return fmt.Errorf("host already has reboot request %s (%s)", old.ID, old.State)
		}
	}
	if _, err := os.Lstat(j.Cron); err == nil {
		return errors.New("cron path already exists; inspect it before preparing a reboot")
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	r.State = "prepared"
	r.CreatedAt = time.Now().UTC()
	if err = j.Save(r); err != nil {
		return err
	}
	if err = durable(j.Cron, []byte(j.cronBody(r)), 0644); err != nil {
		return err
	}
	b, err := os.ReadFile(j.Cron)
	if err != nil {
		return err
	}
	if string(b) != j.cronBody(r) {
		return errors.New("cron readback mismatch")
	}
	return nil
}
func (j Journal) RemoveCron(r *Record) error {
	b, err := os.ReadFile(j.Cron)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if string(b) != j.cronBody(r) {
		return errors.New("refusing to remove a foreign cron entry")
	}
	if err = os.Remove(j.Cron); err != nil {
		return err
	}
	return syncDir(filepath.Dir(j.Cron))
}

// Consume commits before cron removal and before the caller may launch a
// process. A failure after this point intentionally requires operator repair.
func (j Journal) Consume(id, boot string) (*Record, error) {
	r, err := j.Read(id)
	if err != nil {
		return nil, err
	}
	if !uuid.MatchString(boot) {
		return nil, errors.New("invalid boot ID")
	}
	if r.BootID == boot {
		return nil, nil
	}
	if r.State != "armed" {
		if r.State == "prepared" {
			r.State = "failed"
			r.Error = "host booted before handoff was armed"
			if err = j.Save(r); err != nil {
				return nil, err
			}
		}
		return nil, j.RemoveCron(r)
	}
	r.State = "consumed"
	r.ResumeBootID = boot
	if time.Since(r.CreatedAt) > 24*time.Hour {
		r.State = "expired"
		r.Error = "reboot handoff expired"
	}
	if err = j.Save(r); err != nil {
		return nil, err
	}
	if err = j.RemoveCron(r); err != nil {
		return nil, err
	}
	if r.State == "expired" {
		return nil, errors.New(r.Error)
	}
	return r, nil
}
