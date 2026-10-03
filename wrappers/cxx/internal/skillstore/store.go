// Package skillstore writes the fleet's shared Skills as native on-disk skill
// directories (<root>/<slug>/SKILL.md plus auxiliary files) for engines whose
// CLI loads skills from disk. It follows the ownership rules of clx's
// ~/.claude/skills store (persona/claude/lifecycle/collections.go): only
// manifest-recorded directories are written, pruned, or stripped; a directory
// the manifest does not own belongs to the user and is never adopted; every
// bundle is verified against its advertised digest and swapped in atomically.
package skillstore

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
)

// File is one auxiliary file of a source-owned skill bundle.
type File struct {
	Path    string `json:"path"`
	SHA256  string `json:"sha256"`
	Content string `json:"content"`
}

// Item is one entry of a server skills bundle (`grok_skills`, `claude_skills`).
// Content and Files are omitted together when the host's advertised digest
// already matches.
type Item struct {
	Slug           string `json:"slug"`
	SHA256         string `json:"sha256"`
	Status         string `json:"status"`
	Content        string `json:"content,omitempty"`
	ManifestSHA256 string `json:"manifest_sha256,omitempty"`
	Files          []File `json:"files,omitempty"`
}

type entry struct {
	Filename       string            `json:"filename"`
	SHA256         string            `json:"sha256"`
	ManifestSHA256 string            `json:"manifest_sha256,omitempty"`
	Files          []string          `json:"files,omitempty"`
	FileSHA256     map[string]string `json:"file_sha256,omitempty"`
}

type manifest struct {
	Version int              `json:"version"`
	Items   map[string]entry `json:"items"`
}

// Store is one engine's native skills directory and its ownership manifest.
type Store struct {
	Root         string // e.g. ~/.grok/skills
	ManifestPath string // e.g. ~/.cgx/state/skills.json
	Label        string // engine name used in errors, e.g. "Grok"
}

// Apply reconciles the directory with the complete live set. A nil slice means
// the server sent no bundle (older server) and changes nothing; an empty
// non-nil slice is authoritative and prunes every owned skill.
func (s Store) Apply(items []Item) (updated bool, resultErr error) {
	if items == nil {
		return false, nil
	}
	man := s.load()
	next := map[string]entry{}
	for _, it := range items {
		prev, recorded := man.Items[it.Slug]
		keepPrevious := func() {
			if recorded {
				next[it.Slug] = prev
			}
		}
		name := sanitizeSlug(it.Slug)
		if name == "" {
			resultErr = errors.Join(resultErr, fmt.Errorf("%s skill %q has an unsafe slug", s.Label, it.Slug))
			keepPrevious()
			continue
		}
		if recorded {
			if _, ok := ownership(it.Slug, prev); !ok {
				resultErr = errors.Join(resultErr, fmt.Errorf("%s skill %q has an invalid ownership record", s.Label, it.Slug))
				keepPrevious()
				continue
			}
		}
		dir := filepath.Join(s.Root, name)
		if !recorded && exists(dir) {
			// Unowned directories belong to the user or another tool.
			resultErr = errors.Join(resultErr, fmt.Errorf("%s skill %q conflicts with an unmanaged local directory", s.Label, it.Slug))
			continue
		}
		if recorded && prev.SHA256 == it.SHA256 && bundlePresent(dir, prev) {
			next[it.Slug] = prev
			continue
		}
		if it.Content == "" {
			resultErr = errors.Join(resultErr, fmt.Errorf("%s skill %q is missing content", s.Label, it.Slug))
			if recorded && !bundlePresent(dir, prev) {
				// Keep ownership but withhold the digest so the next sync heals it.
				prev.SHA256 = ""
				next[it.Slug] = prev
			} else {
				keepPrevious()
			}
			continue
		}
		written, err := replaceBundle(s.Root, name, it)
		if err != nil {
			resultErr = errors.Join(resultErr, fmt.Errorf("write %s skill %q: %w", s.Label, it.Slug, err))
			keepPrevious()
			continue
		}
		updated = true
		next[it.Slug] = entry{Filename: filepath.Join(name, "SKILL.md"), SHA256: it.SHA256, ManifestSHA256: written.manifestSHA256, Files: written.files, FileSHA256: written.fileSHA256}
	}
	for slug, rec := range man.Items {
		if _, kept := next[slug]; kept {
			continue
		}
		name, ok := ownership(slug, rec)
		if !ok {
			next[slug] = rec
			resultErr = errors.Join(resultErr, fmt.Errorf("prune %s skill %q: invalid ownership record", s.Label, slug))
			continue
		}
		if err := os.RemoveAll(filepath.Join(s.Root, name)); err != nil && !os.IsNotExist(err) {
			next[slug] = rec // retried on the next sync
			resultErr = errors.Join(resultErr, fmt.Errorf("prune %s skill %q: %w", s.Label, slug, err))
			continue
		}
		updated = true
	}
	man.Items = next
	if err := s.save(man); err != nil {
		resultErr = errors.Join(resultErr, fmt.Errorf("save %s skill manifest: %w", s.Label, err))
	}
	return updated, resultErr
}

// Digests advertises the digest of every owned skill whose directory still
// matches its record exactly, so the server can omit unchanged content.
func (s Store) Digests() map[string]string {
	out := map[string]string{}
	for slug, rec := range s.load().Items {
		name, ok := ownership(slug, rec)
		if ok && rec.SHA256 != "" && bundlePresent(filepath.Join(s.Root, name), rec) {
			out[slug] = rec.SHA256
		}
	}
	return out
}

// Count is the number of skills the manifest owns.
func (s Store) Count() int { return len(s.load().Items) }

// Strip removes every owned skill directory (uninstall or trust loss). The
// root and user-authored directories are never touched.
func (s Store) Strip() error {
	man := s.load()
	remaining := map[string]entry{}
	var resultErr error
	for slug, rec := range man.Items {
		name, ok := ownership(slug, rec)
		if !ok {
			remaining[slug] = rec
			resultErr = errors.Join(resultErr, fmt.Errorf("strip %s skill %q: unsafe manifest path", s.Label, slug))
			continue
		}
		if err := os.RemoveAll(filepath.Join(s.Root, name)); err != nil && !os.IsNotExist(err) {
			remaining[slug] = rec
			resultErr = errors.Join(resultErr, fmt.Errorf("strip %s skill %q: %w", s.Label, slug, err))
		}
	}
	if len(remaining) == 0 {
		if err := os.Remove(s.ManifestPath); err != nil && !os.IsNotExist(err) {
			resultErr = errors.Join(resultErr, err)
		}
		return resultErr
	}
	man.Items = remaining
	return errors.Join(resultErr, s.save(man))
}

func (s Store) load() manifest {
	m := manifest{Version: 1, Items: map[string]entry{}}
	raw, err := os.ReadFile(s.ManifestPath)
	if err != nil {
		return m
	}
	var parsed manifest
	if json.Unmarshal(raw, &parsed) != nil || parsed.Items == nil {
		return m
	}
	return parsed
}

func (s Store) save(m manifest) error {
	m.Version = 1
	if m.Items == nil {
		m.Items = map[string]entry{}
	}
	body, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.ManifestPath), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(s.ManifestPath), ".skills-*.json")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(body); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), s.ManifestPath)
}

// sanitizeSlug rejects path separators, traversal, dot-only names and anything
// outside the server's slug alphabet.
func sanitizeSlug(slug string) string {
	if slug == "" || slug != filepath.Base(slug) || strings.Contains(slug, "..") || strings.Trim(slug, ".") == "" || strings.ContainsAny(slug, "/\\") {
		return ""
	}
	for _, r := range slug {
		if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '.' || r == '_' || r == '-') {
			return ""
		}
	}
	return slug
}

// ownership accepts a record only when its filename belongs to its own slug, so
// a corrupted record for slug A can never authorize removing directory B.
func ownership(slug string, rec entry) (string, bool) {
	name := sanitizeSlug(slug)
	if name == "" || rec.Filename != filepath.Join(name, "SKILL.md") {
		return "", false
	}
	return name, true
}

func exists(p string) bool {
	_, err := os.Lstat(p)
	return err == nil
}

func safeFilePath(raw string) (string, bool) {
	if raw == "" || strings.Contains(raw, "\\") || strings.ContainsRune(raw, '\x00') {
		return "", false
	}
	clean := path.Clean(raw)
	if clean != raw || clean == "." || path.IsAbs(clean) || clean == "SKILL.md" || strings.HasPrefix(clean, "../") {
		return "", false
	}
	return filepath.FromSlash(clean), true
}

func digest(content string) string { return fmt.Sprintf("%x", sha256.Sum256([]byte(content))) }

func validDigest(content, expected string) bool {
	return len(expected) == 64 && strings.EqualFold(digest(content), expected)
}

func fileMatches(root, relative, expected string) bool {
	if len(expected) != 64 {
		return false
	}
	current := root
	parts := strings.Split(filepath.FromSlash(relative), string(filepath.Separator))
	for _, part := range parts[:len(parts)-1] {
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return false
		}
	}
	target := filepath.Join(root, filepath.FromSlash(relative))
	info, err := os.Lstat(target)
	if err != nil || !info.Mode().IsRegular() {
		return false
	}
	body, err := os.ReadFile(target)
	return err == nil && strings.EqualFold(fmt.Sprintf("%x", sha256.Sum256(body)), expected)
}

// bundlePresent requires the exact owned file/directory set: an injected extra
// file, directory or symlink withholds the digest so the bundle is restored.
func bundlePresent(dir string, rec entry) bool {
	info, err := os.Lstat(dir)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return false
	}
	if !fileMatches(dir, "SKILL.md", rec.ManifestSHA256) || len(rec.FileSHA256) != len(rec.Files) {
		return false
	}
	wantFiles := map[string]struct{}{"SKILL.md": {}}
	wantDirs := map[string]struct{}{}
	for _, raw := range rec.Files {
		rel, ok := safeFilePath(filepath.ToSlash(raw))
		if !ok {
			return false
		}
		canonical := filepath.ToSlash(rel)
		expected, ok := rec.FileSHA256[canonical]
		if !ok || !fileMatches(dir, canonical, expected) {
			return false
		}
		wantFiles[canonical] = struct{}{}
		for parent := path.Dir(canonical); parent != "."; parent = path.Dir(parent) {
			wantDirs[parent] = struct{}{}
		}
	}
	files, dirs := 0, 0
	err = filepath.WalkDir(dir, func(current string, d os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, err := filepath.Rel(dir, current)
		if err != nil || rel == "." {
			return err
		}
		canonical := filepath.ToSlash(rel)
		if d.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("unexpected symlink %s", canonical)
		}
		if d.IsDir() {
			if _, ok := wantDirs[canonical]; !ok {
				return fmt.Errorf("unexpected directory %s", canonical)
			}
			dirs++
			return nil
		}
		if !d.Type().IsRegular() {
			return fmt.Errorf("unexpected non-regular file %s", canonical)
		}
		if _, ok := wantFiles[canonical]; !ok {
			return fmt.Errorf("unexpected file %s", canonical)
		}
		files++
		return nil
	})
	return err == nil && files == len(wantFiles) && dirs == len(wantDirs)
}

// bundleDigest matches the server's canonical complete-bundle digest:
// bytewise-sorted "path\0sha256\n" lines over SKILL.md and every file.
func bundleDigest(manifestSHA256 string, files map[string]string) string {
	paths := make([]string, 0, len(files)+1)
	shas := map[string]string{"SKILL.md": strings.ToLower(manifestSHA256)}
	paths = append(paths, "SKILL.md")
	for p, sha := range files {
		paths = append(paths, p)
		shas[p] = strings.ToLower(sha)
	}
	sort.Strings(paths)
	hash := sha256.New()
	for _, p := range paths {
		_, _ = hash.Write([]byte(p))
		_, _ = hash.Write([]byte{0})
		_, _ = hash.Write([]byte(shas[p]))
		_, _ = hash.Write([]byte{'\n'})
	}
	return fmt.Sprintf("%x", hash.Sum(nil))
}

type written struct {
	manifestSHA256 string
	files          []string
	fileSHA256     map[string]string
}

// replaceBundle stages and verifies the complete directory, then swaps it in.
// Any failure leaves the previous directory untouched.
func replaceBundle(root, name string, it Item) (written, error) {
	manifestSHA256 := digest(it.Content)
	directory := it.ManifestSHA256 != "" || it.Files != nil
	if directory {
		if !validDigest(it.Content, it.ManifestSHA256) {
			return written{}, errors.New("SKILL.md has invalid sha256")
		}
	} else if !validDigest(it.Content, it.SHA256) {
		return written{}, errors.New("SKILL.md does not match advertised sha256")
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return written{}, err
	}
	stage, err := os.MkdirTemp(root, "."+name+".new-")
	if err != nil {
		return written{}, err
	}
	defer func() { _ = os.RemoveAll(stage) }()
	if err := os.WriteFile(filepath.Join(stage, "SKILL.md"), []byte(it.Content), 0o644); err != nil {
		return written{}, err
	}
	out := written{manifestSHA256: manifestSHA256, files: []string{}, fileSHA256: map[string]string{}}
	seen := map[string]struct{}{}
	for _, file := range it.Files {
		rel, ok := safeFilePath(file.Path)
		if !ok {
			return written{}, fmt.Errorf("unsafe auxiliary path %q", file.Path)
		}
		canonical := filepath.ToSlash(rel)
		if _, dup := seen[strings.ToLower(canonical)]; dup {
			return written{}, fmt.Errorf("duplicate auxiliary path %q", file.Path)
		}
		seen[strings.ToLower(canonical)] = struct{}{}
		if !validDigest(file.Content, file.SHA256) {
			return written{}, fmt.Errorf("auxiliary file %q has invalid sha256", file.Path)
		}
		target := filepath.Join(stage, rel)
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return written{}, err
		}
		if err := os.WriteFile(target, []byte(file.Content), 0o644); err != nil {
			return written{}, err
		}
		out.files = append(out.files, canonical)
		out.fileSHA256[canonical] = digest(file.Content)
	}
	sort.Strings(out.files)
	if directory && (len(it.SHA256) != 64 || !strings.EqualFold(bundleDigest(manifestSHA256, out.fileSHA256), it.SHA256)) {
		return written{}, errors.New("skill bundle does not match advertised sha256")
	}
	target := filepath.Join(root, name)
	backup := stage + ".old"
	had := exists(target)
	if had {
		if err := os.Rename(target, backup); err != nil {
			return written{}, err
		}
	}
	if err := os.Rename(stage, target); err != nil {
		if had {
			_ = os.Rename(backup, target)
		}
		return written{}, err
	}
	_ = os.RemoveAll(backup)
	return out, nil
}
