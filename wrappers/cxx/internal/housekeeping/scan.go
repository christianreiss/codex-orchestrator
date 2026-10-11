package housekeeping

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

var uuidRE = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
var rolloutRE = regexp.MustCompile(`^rollout-.*-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$`)

type artifact struct {
	Path     string
	Size     int64
	Modified time.Time
	Mode     fs.FileMode
}
type session struct {
	Parent    string
	ID        string
	IDs       []string
	Files     []artifact
	Bytes     int64
	Modified  time.Time
	Protected bool
	Reason    string
}

func safePath(root, path string) error {
	rel, err := filepath.Rel(root, path)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return errors.New("artifact outside native home")
	}
	cur := root
	if s, err := os.Lstat(root); err != nil || !s.IsDir() || s.Mode()&os.ModeSymlink != 0 {
		return errors.New("native home is not a real directory")
	}
	for _, p := range strings.Split(rel, string(os.PathSeparator)) {
		cur = filepath.Join(cur, p)
		s, err := os.Lstat(cur)
		if err != nil {
			return err
		}
		if s.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("symlink artifact: %s", rel)
		}
	}
	return nil
}
func addArtifact(root, path string, s *session) error {
	if err := safePath(root, path); err != nil {
		return err
	}
	st, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !st.Mode().IsRegular() {
		return errors.New("nonregular session artifact")
	}
	s.Files = append(s.Files, artifact{path, st.Size(), st.ModTime(), st.Mode()})
	s.Bytes += st.Size()
	if st.ModTime().After(s.Modified) {
		s.Modified = st.ModTime()
	}
	return nil
}
func addTree(root, path string, s *session) error {
	return filepath.WalkDir(path, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.Type()&os.ModeSymlink != 0 {
			return errors.New("session artifact symlink")
		}
		if !d.IsDir() {
			return addArtifact(root, p, s)
		}
		return safePath(root, p)
	})
}
func scan(root, engine string) ([]session, error) {
	var result []session
	switch engine {
	case "codex":
		for _, folder := range []string{"sessions", "archived_sessions"} {
			base := filepath.Join(root, folder)
			if _, err := os.Lstat(base); os.IsNotExist(err) {
				continue
			}
			err := filepath.WalkDir(base, func(path string, d fs.DirEntry, err error) error {
				if err != nil {
					return err
				}
				if d.Type()&os.ModeSymlink != 0 {
					return errors.New("symlink in session tree")
				}
				if d.IsDir() {
					return safePath(root, path)
				}
				m := rolloutRE.FindStringSubmatch(d.Name())
				if len(m) == 0 {
					return nil
				}
				s := session{ID: m[1], IDs: []string{m[1]}}
				if err := addArtifact(root, path, &s); err != nil {
					return err
				}
				snapshot := filepath.Join(root, "shell_snapshots", s.ID+".sh")
				if _, err := os.Lstat(snapshot); err == nil {
					if err = addArtifact(root, snapshot, &s); err != nil {
						return err
					}
				} else if !os.IsNotExist(err) {
					return err
				}
				result = append(result, s)
				return nil
			})
			if err != nil {
				return nil, err
			}
		}
	case "claude":
		projects, err := os.ReadDir(filepath.Join(root, "projects"))
		if os.IsNotExist(err) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		for _, p := range projects {
			if !p.IsDir() {
				continue
			}
			base := filepath.Join(root, "projects", p.Name())
			if err = safePath(root, base); err != nil {
				return nil, err
			}
			files, err := os.ReadDir(base)
			if err != nil {
				return nil, err
			}
			for _, f := range files {
				id := strings.TrimSuffix(f.Name(), ".jsonl")
				if f.IsDir() || !strings.HasSuffix(f.Name(), ".jsonl") || !uuidRE.MatchString(id) {
					continue
				}
				s := session{ID: id, IDs: []string{id}}
				if err = addArtifact(root, filepath.Join(base, f.Name()), &s); err != nil {
					return nil, err
				}
				artifacts := filepath.Join(base, id)
				if _, err = os.Lstat(artifacts); err == nil {
					if err = addTree(root, artifacts, &s); err != nil {
						return nil, err
					}
				} else if !os.IsNotExist(err) {
					return nil, err
				}
				result = append(result, s)
			}
		}
	case "grok":
		projects, err := os.ReadDir(filepath.Join(root, "sessions"))
		if os.IsNotExist(err) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		for _, p := range projects {
			if !p.IsDir() {
				continue
			}
			base := filepath.Join(root, "sessions", p.Name())
			if err = safePath(root, base); err != nil {
				return nil, err
			}
			dirs, err := os.ReadDir(base)
			if err != nil {
				return nil, err
			}
			for _, d := range dirs {
				if !d.IsDir() || !uuidRE.MatchString(d.Name()) {
					continue
				}
				s := session{ID: d.Name(), IDs: []string{d.Name()}}
				if err = addTree(root, filepath.Join(base, d.Name()), &s); err != nil {
					return nil, err
				}
				raw, err := os.ReadFile(filepath.Join(base, d.Name(), "summary.json"))
				if os.IsNotExist(err) {
					s.Protected = true
					s.Reason = "incomplete_native_metadata"
				} else if err != nil {
					return nil, err
				} else {
					var meta struct {
						Info struct {
							ID string `json:"id"`
						} `json:"info"`
						Parent string `json:"parent_session_id"`
						Pinned bool   `json:"pinned"`
					}
					if err = json.Unmarshal(raw, &meta); err != nil || meta.Info.ID != s.ID {
						return nil, errors.New("unsupported Grok session summary")
					}
					if meta.Parent != "" && !uuidRE.MatchString(meta.Parent) {
						return nil, errors.New("invalid Grok parent session")
					}
					s.Parent = meta.Parent
					if meta.Pinned {
						s.Protected = true
						s.Reason = "native_pin"
					}
				}
				result = append(result, s)
			}
		}
	default:
		return nil, errors.New("unsupported engine")
	}
	seen := map[string]bool{}
	for _, s := range result {
		if seen[s.ID] {
			return nil, errors.New("ambiguous duplicate native session id")
		}
		seen[s.ID] = true
	}
	return result, nil
}
func selectSessions(sessions []session, p Policy, now time.Time) ([]session, int64, int) {
	sort.Slice(sessions, func(i, j int) bool {
		if sessions[i].Modified.Equal(sessions[j].Modified) {
			return sessions[i].ID < sessions[j].ID
		}
		return sessions[i].Modified.Before(sessions[j].Modified)
	})
	var total int64
	protected := 0
	for _, s := range sessions {
		total += s.Bytes
		if s.Protected {
			protected++
		}
	}
	remaining := total
	var chosen []session
	for _, s := range sessions {
		if s.Protected {
			continue
		}
		age := now.Sub(s.Modified)
		if age >= time.Duration(p.RetentionDays)*24*time.Hour || remaining > p.MaxBytes && age >= time.Duration(p.MinAgeDays)*24*time.Hour {
			chosen = append(chosen, s)
			remaining -= s.Bytes
		}
	}
	return chosen, total, protected
}

// Read metadata-sized JSONL records without loading multi-gigabyte history.
func rewriteJSONL(root, path string, ids map[string]bool, key string) error {
	if _, err := os.Lstat(path); os.IsNotExist(err) {
		return nil
	}
	if err := safePath(root, path); err != nil {
		return err
	}
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	tmp, err := os.CreateTemp(filepath.Dir(path), ".housekeeping-index-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	defer tmp.Close()
	scan := bufio.NewScanner(f)
	scan.Buffer(make([]byte, 65536), 64<<20)
	for scan.Scan() {
		var row map[string]json.RawMessage
		if err = json.Unmarshal(scan.Bytes(), &row); err != nil {
			return err
		}
		var id string
		_ = json.Unmarshal(row[key], &id)
		if !ids[id] {
			if _, err = tmp.Write(append(append([]byte{}, scan.Bytes()...), '\n')); err != nil {
				return err
			}
		}
	}
	if err = scan.Err(); err != nil {
		return err
	}
	if err = tmp.Sync(); err != nil {
		return err
	}
	if err = tmp.Close(); err != nil {
		return err
	}
	return os.Rename(name, path)
}

// Validate native index formats before quarantining anything. A malformed or
// incomplete tail is not permission to silently discard unrelated history.
func preflightIndexes(root, engine string) error {
	var jsonl []string
	var objects []string
	switch engine {
	case "codex":
		jsonl = []string{filepath.Join(root, "session_index.jsonl"), filepath.Join(root, "history.jsonl")}
		objects = []string{filepath.Join(root, ".codex-global-state.json"), filepath.Join(root, ".codex-global-state.json.bak")}
	case "claude":
		jsonl = []string{filepath.Join(root, "history.jsonl")}
		objects, _ = filepath.Glob(filepath.Join(root, "projects", "*", "sessions-index.json"))
	case "grok":
		jsonl, _ = filepath.Glob(filepath.Join(root, "sessions", "*", "prompt_history.jsonl"))
	}
	for _, path := range append(append([]string{}, jsonl...), objects...) {
		if _, err := os.Lstat(path); os.IsNotExist(err) {
			continue
		}
		if err := safePath(root, path); err != nil {
			return err
		}
	}
	for _, path := range jsonl {
		f, err := os.Open(path)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return err
		}
		s := bufio.NewScanner(f)
		s.Buffer(make([]byte, 65536), 64<<20)
		for s.Scan() {
			var row map[string]json.RawMessage
			if err = json.Unmarshal(s.Bytes(), &row); err != nil {
				f.Close()
				return fmt.Errorf("unsupported native history record: %s", filepath.Base(path))
			}
		}
		err = s.Err()
		f.Close()
		if err != nil {
			return err
		}
	}
	for _, path := range objects {
		raw, err := os.ReadFile(path)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return err
		}
		var row map[string]json.RawMessage
		if err = json.Unmarshal(raw, &row); err != nil {
			return fmt.Errorf("unsupported native index: %s", filepath.Base(path))
		}
		if engine == "claude" {
			var entries []map[string]json.RawMessage
			if row["entries"] == nil {
				return errors.New("unknown Claude session index")
			}
			if err = json.Unmarshal(row["entries"], &entries); err != nil {
				return err
			}
		}
	}
	return nil
}
