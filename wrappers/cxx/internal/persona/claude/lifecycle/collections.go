// collections.go applies the Claude-native fleet collections (subagents,
// slash-commands, output-styles) to ~/.claude/{agents,commands,output-styles}.
//
// Contract with the orchestrator (see api host-claude-artifacts.ts):
//   - The bundle returns the COMPLETE live set per kind; `content` is present
//     only when the item's sha differs from the wrapper's on-disk digest.
//   - We persist a per-collection manifest under ~/.clx/state/collections/ that
//     records exactly the files WE wrote. Pruning removes only manifest-recorded
//     files that are absent from the new set — user-authored files in those dirs
//     (anything not in our manifest) are never touched. This is the deliberate
//     opposite of the legacy whole-dir skill purge in skills.go.
//   - Ordering is write-changed → prune → write-manifest-last, so a crash never
//     leaves a manifest pointing at missing files (orphans are reconciled next run).
package lifecycle

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/observability/tracing"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/orchestrator"
)

// artifactDirs maps a collection kind to its ~/.claude subdirectory.
var artifactDirs = map[string]string{
	"subagent":     "agents",
	"command":      "commands",
	"output-style": "output-styles",
}

type manifestEntry struct {
	Filename       string `json:"filename"`
	SHA256         string `json:"sha256"`
	ManifestSHA256 string `json:"manifest_sha256,omitempty"`
	// Files is populated for directory-backed skills and records every relative
	// file the fleet owns. Older manifests omit it and remain compatible.
	Files      []string          `json:"files,omitempty"`
	FileSHA256 map[string]string `json:"file_sha256,omitempty"`
}

type collectionManifest struct {
	Version int                      `json:"version"`
	Items   map[string]manifestEntry `json:"items"`
}

func claudeSubdir(sub string) string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".claude", sub)
}

func collectionManifestPath(dir string) string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".clx", "state", "collections", dir+".json")
}

// sanitizeSlug guards the filename write: a slug is a path-traversal primitive,
// so reject anything with separators, "..", or characters outside the host-side
// SLUG_RE. Returns "" for an unsafe slug (caller skips it).
func sanitizeSlug(slug string) string {
	if slug == "" || slug != filepath.Base(slug) || strings.Contains(slug, "..") {
		return ""
	}
	if strings.Trim(slug, ".") == "" {
		// Reject slugs composed entirely of dots (".", "...", etc.) — these
		// normalize away under filepath.Join/Clean and would collapse a
		// per-slug path onto its parent directory.
		return ""
	}
	if strings.ContainsAny(slug, "/\\") {
		return ""
	}
	for _, r := range slug {
		ok := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '.' || r == '_' || r == '-'
		if !ok {
			return ""
		}
	}
	return slug
}

func loadManifest(path string) collectionManifest {
	m := collectionManifest{Version: 1, Items: map[string]manifestEntry{}}
	raw, err := os.ReadFile(path)
	if err != nil {
		return m
	}
	var parsed collectionManifest
	if err := json.Unmarshal(raw, &parsed); err != nil || parsed.Items == nil {
		return m
	}
	return parsed
}

func saveManifest(path string, m collectionManifest) error {
	m.Version = 1
	if m.Items == nil {
		m.Items = map[string]manifestEntry{}
	}
	body, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	return atomicWrite(path, body, 0o600)
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func safeSkillFilePath(raw string) (string, bool) {
	// Provider paths are canonical slash-separated relative paths. Reject a
	// backslash even on Unix so the same payload cannot become traversal on a
	// Windows client.
	if raw == "" || strings.Contains(raw, "\\") || strings.ContainsRune(raw, '\x00') {
		return "", false
	}
	clean := path.Clean(raw)
	if clean != raw || clean == "." || path.IsAbs(clean) || clean == "SKILL.md" || strings.HasPrefix(clean, "../") {
		return "", false
	}
	return filepath.FromSlash(clean), true
}

func canonicalSkillOwnership(slug string, rec manifestEntry) (string, bool) {
	name := sanitizeSlug(slug)
	if name == "" || rec.Filename != filepath.Join(name, "SKILL.md") {
		return "", false
	}
	return name, true
}

func managedSkillFileMatches(root, relative, expected string) bool {
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
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return false
	}
	body, err := os.ReadFile(target)
	if err != nil {
		return false
	}
	got := fmt.Sprintf("%x", sha256.Sum256(body))
	return strings.EqualFold(got, expected)
}

func skillBundlePresent(dir string, rec manifestEntry) bool {
	info, err := os.Lstat(dir)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return false
	}
	expectedFiles := map[string]struct{}{"SKILL.md": {}}
	expectedDirs := map[string]struct{}{}
	if !managedSkillFileMatches(dir, "SKILL.md", rec.ManifestSHA256) {
		return false
	}
	if len(rec.FileSHA256) != len(rec.Files) {
		return false
	}
	for _, raw := range rec.Files {
		rel, ok := safeSkillFilePath(filepath.ToSlash(raw))
		if !ok {
			return false
		}
		canonical := filepath.ToSlash(rel)
		expected, ok := rec.FileSHA256[canonical]
		if !ok || !managedSkillFileMatches(dir, canonical, expected) {
			return false
		}
		expectedFiles[canonical] = struct{}{}
		for parent := path.Dir(canonical); parent != "."; parent = path.Dir(parent) {
			expectedDirs[parent] = struct{}{}
		}
	}

	// A fleet-owned skill is a complete directory bundle, not a set of files
	// overlaid onto user content. WalkDir does not follow symlinks; requiring the
	// exact file/directory set prevents an injected extra script, directory, or
	// symlink from surviving while we advertise the canonical bundle digest.
	seenFiles := map[string]struct{}{}
	seenDirs := map[string]struct{}{}
	err = filepath.WalkDir(dir, func(current string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, relErr := filepath.Rel(dir, current)
		if relErr != nil {
			return relErr
		}
		if rel == "." {
			return nil
		}
		canonical := filepath.ToSlash(rel)
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("unexpected symlink %s", canonical)
		}
		if entry.IsDir() {
			if _, ok := expectedDirs[canonical]; !ok {
				return fmt.Errorf("unexpected directory %s", canonical)
			}
			seenDirs[canonical] = struct{}{}
			return nil
		}
		entryInfo, infoErr := entry.Info()
		if infoErr != nil {
			return infoErr
		}
		if !entryInfo.Mode().IsRegular() {
			return fmt.Errorf("unexpected non-regular file %s", canonical)
		}
		if _, ok := expectedFiles[canonical]; !ok {
			return fmt.Errorf("unexpected file %s", canonical)
		}
		seenFiles[canonical] = struct{}{}
		return nil
	})
	return err == nil && len(seenFiles) == len(expectedFiles) && len(seenDirs) == len(expectedDirs)
}

func collectionFileDigest(content string) string {
	return fmt.Sprintf("%x", sha256.Sum256([]byte(content)))
}

func validCollectionFileDigest(content, expected string) bool {
	if len(expected) != 64 {
		return false
	}
	got := collectionFileDigest(content)
	return strings.EqualFold(got, expected)
}

type skillBundleDigestEntry struct {
	path   string
	sha256 string
}

func canonicalSkillBundleDigest(manifestSHA256 string, files map[string]string) string {
	entries := make([]skillBundleDigestEntry, 0, len(files)+1)
	entries = append(entries, skillBundleDigestEntry{path: "SKILL.md", sha256: strings.ToLower(manifestSHA256)})
	for filePath, fileSHA256 := range files {
		entries = append(entries, skillBundleDigestEntry{path: filePath, sha256: strings.ToLower(fileSHA256)})
	}
	// Go string ordering is bytewise. The API uses Buffer.compare over UTF-8 bytes
	// so this is one language-neutral canonical ordering for every valid path.
	sort.Slice(entries, func(i, j int) bool { return entries[i].path < entries[j].path })
	hash := sha256.New()
	for _, entry := range entries {
		_, _ = hash.Write([]byte(entry.path))
		_, _ = hash.Write([]byte{0})
		_, _ = hash.Write([]byte(entry.sha256))
		_, _ = hash.Write([]byte{'\n'})
	}
	return fmt.Sprintf("%x", hash.Sum(nil))
}

type writtenSkillBundle struct {
	ManifestSHA256 string
	Files          []string
	FileSHA256     map[string]string
}

// replaceSkillBundle stages the complete directory and swaps it into place.
// A failed validation/write leaves the previous directory untouched.
func replaceSkillBundle(skillsRoot, name string, it orchestrator.CollectionItem) (writtenSkillBundle, error) {
	empty := writtenSkillBundle{}
	manifestSHA256 := collectionFileDigest(it.Content)
	directoryBundle := it.ManifestSHA256 != "" || it.Files != nil
	if directoryBundle {
		if !validCollectionFileDigest(it.Content, it.ManifestSHA256) {
			return empty, errors.New("SKILL.md has invalid sha256")
		}
	} else if !validCollectionFileDigest(it.Content, it.SHA256) {
		return empty, errors.New("SKILL.md does not match advertised sha256")
	}
	if err := os.MkdirAll(skillsRoot, 0o755); err != nil {
		return empty, err
	}
	stage, err := os.MkdirTemp(skillsRoot, "."+name+".new-")
	if err != nil {
		return empty, err
	}
	defer func() { _ = os.RemoveAll(stage) }()
	if err := os.WriteFile(filepath.Join(stage, "SKILL.md"), []byte(it.Content), 0o644); err != nil {
		return empty, err
	}
	written := make([]string, 0, len(it.Files))
	writtenSHA := make(map[string]string, len(it.Files))
	seen := map[string]struct{}{}
	for _, file := range it.Files {
		rel, ok := safeSkillFilePath(file.Path)
		if !ok {
			return empty, fmt.Errorf("unsafe auxiliary path %q", file.Path)
		}
		canonical := filepath.ToSlash(rel)
		// The same payload must be safe on case-sensitive Linux and the usual
		// case-insensitive macOS filesystems. Importers enforce this too; keep the
		// wrapper as the final trust boundary.
		collisionKey := strings.ToLower(canonical)
		if _, duplicate := seen[collisionKey]; duplicate {
			return empty, fmt.Errorf("duplicate auxiliary path %q", file.Path)
		}
		seen[collisionKey] = struct{}{}
		if !validCollectionFileDigest(file.Content, file.SHA256) {
			return empty, fmt.Errorf("auxiliary file %q has invalid sha256", file.Path)
		}
		target := filepath.Join(stage, rel)
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return empty, err
		}
		if err := os.WriteFile(target, []byte(file.Content), 0o644); err != nil {
			return empty, err
		}
		written = append(written, canonical)
		writtenSHA[canonical] = collectionFileDigest(file.Content)
	}
	sort.Strings(written)
	if directoryBundle {
		bundleSHA256 := canonicalSkillBundleDigest(manifestSHA256, writtenSHA)
		if len(it.SHA256) != 64 || !strings.EqualFold(bundleSHA256, it.SHA256) {
			return empty, errors.New("skill bundle does not match advertised sha256")
		}
	}

	target := filepath.Join(skillsRoot, name)
	backup := stage + ".old"
	hadTarget := fileExists(target)
	if hadTarget {
		if err := os.Rename(target, backup); err != nil {
			return empty, err
		}
	}
	if err := os.Rename(stage, target); err != nil {
		if hadTarget {
			_ = os.Rename(backup, target)
		}
		return empty, err
	}
	// The new directory is authoritative now. A stale hidden backup is safer
	// than rolling back a successful swap because cleanup alone failed.
	_ = os.RemoveAll(backup)
	return writtenSkillBundle{
		ManifestSHA256: manifestSHA256,
		Files:          written,
		FileSHA256:     writtenSHA,
	}, nil
}

// applyCollection writes/prunes one collection kind and returns whether anything
// changed on disk.
func applyCollection(kind string, items []orchestrator.CollectionItem, logger *slog.Logger) bool {
	updated, _ := applyCollectionResult(context.Background(), kind, items, logger)
	return updated
}

// applyCollectionResult carries a context solely to parent its span; nothing in
// the body is cancellable. The span lives here rather than on applyCollection
// because the bundle path (bootstrap → applyClaudeArtifactsResult) never calls
// the bool wrapper, and instrumenting the wrapper alone would produce spans in
// tests and none in a shipped binary.
func applyCollectionResult(ctx context.Context, kind string, items []orchestrator.CollectionItem, logger *slog.Logger) (updated bool, resultErr error) {
	_, span := tracing.Start(ctx, "cxx.apply.collection",
		tracing.String("wrapper.engine", "claude"),
		tracing.String("wrapper.collection_kind", kind),
		tracing.Int("wrapper.item_count", len(items)),
	)
	defer func() {
		span.SetBool("wrapper.updated", updated)
		span.Fail(resultErr)
		span.End()
	}()

	dir, ok := artifactDirs[kind]
	if !ok {
		return false, fmt.Errorf("unknown Claude collection kind %q", kind)
	}
	targetDir := claudeSubdir(dir)
	man := loadManifest(collectionManifestPath(dir))
	newItems := map[string]manifestEntry{}

	for _, it := range items {
		prev, known := man.Items[it.Slug]
		preservePrevious := func() {
			if known {
				newItems[it.Slug] = prev
			}
		}
		name := sanitizeSlug(it.Slug)
		if name == "" {
			logger.Warn("skipping artifact with unsafe slug", "kind", kind, "slug", it.Slug)
			resultErr = errors.Join(resultErr, fmt.Errorf("%s artifact %q has an unsafe slug", kind, it.Slug))
			preservePrevious()
			continue
		}
		path := filepath.Join(targetDir, name+".md")
		if known && prev.SHA256 == it.SHA256 && fileExists(path) {
			// If-None-Match: unchanged and present — leave it.
		} else if it.Content != "" {
			if err := atomicWrite(path, []byte(it.Content), 0o644); err != nil {
				logger.Debug("collection write failed", "kind", kind, "slug", it.Slug, "err", err)
				resultErr = errors.Join(resultErr, fmt.Errorf("write %s artifact %q: %w", kind, it.Slug, err))
				preservePrevious()
				continue
			}
			updated = true
		} else {
			// Server flagged a change but sent no content. Keep any
			// last-known-good file/manifest and re-request next run.
			resultErr = errors.Join(resultErr, fmt.Errorf("%s artifact %q is missing content", kind, it.Slug))
			preservePrevious()
			continue
		}
		newItems[it.Slug] = manifestEntry{Filename: name + ".md", SHA256: it.SHA256}
	}

	// Prune ONLY files we previously wrote that are gone from the live set.
	for slug, rec := range man.Items {
		if _, stillPresent := newItems[slug]; stillPresent {
			continue
		}
		if err := os.Remove(filepath.Join(targetDir, rec.Filename)); err != nil && !os.IsNotExist(err) {
			logger.Debug("collection prune failed", "kind", kind, "slug", slug, "err", err)
			resultErr = errors.Join(resultErr, fmt.Errorf("prune %s artifact %q: %w", kind, slug, err))
			// Keep ownership in the manifest so the next sync retries the prune.
			newItems[slug] = rec
			continue
		}
		updated = true
	}

	man.Items = newItems
	if err := saveManifest(collectionManifestPath(dir), man); err != nil {
		logger.Debug("collection manifest write failed", "kind", kind, "err", err)
		resultErr = errors.Join(resultErr, fmt.Errorf("save %s collection manifest: %w", kind, err))
	}
	return updated, resultErr
}

func applyClaudeArtifactsResult(ctx context.Context, ca *orchestrator.ClaudeArtifacts, logger *slog.Logger) (updated bool, resultErr error) {
	if ca == nil {
		return false, nil
	}
	ctx, span := tracing.Start(ctx, "cxx.apply.claude_artifacts",
		tracing.String("wrapper.engine", "claude"),
		tracing.Int("wrapper.item_count", len(ca.Subagents)+len(ca.Commands)+len(ca.OutputStyles)),
	)
	defer func() {
		span.SetBool("wrapper.updated", updated)
		span.Fail(resultErr)
		span.End()
	}()

	updated, resultErr = applyCollectionResult(ctx, "subagent", ca.Subagents, logger)
	changed, err := applyCollectionResult(ctx, "command", ca.Commands, logger)
	updated = updated || changed
	resultErr = errors.Join(resultErr, err)
	changed, err = applyCollectionResult(ctx, "output-style", ca.OutputStyles, logger)
	return updated || changed, errors.Join(resultErr, err)
}

// artifactDigestsForRequest reads the manifests so the bootstrap request can
// advertise what the host already has on disk (enables If-None-Match).
func artifactDigestsForRequest() map[string]map[string]string {
	out := map[string]map[string]string{}
	for kind, dir := range artifactDirs {
		man := loadManifest(collectionManifestPath(dir))
		if len(man.Items) == 0 {
			continue
		}
		m := map[string]string{}
		for slug, rec := range man.Items {
			m[slug] = rec.SHA256
		}
		out[kind] = m
	}
	return out
}

// applyClaudeSkills writes the fleet's shared skills as native Claude Code skill
// files at ~/.claude/skills/<slug>/SKILL.md. Unlike the flat collections above,
// each skill is its own DIRECTORY (Claude Code's native skill layout), so prune
// uses RemoveAll on the skill dir — only manifest-recorded ones; user-authored
// skill dirs and the skills/ root are never touched. (Claude Code can't read
// skills over MCP, so on-disk is the only way; codex stays MCP-only.)
func applyClaudeSkills(items []orchestrator.CollectionItem, logger *slog.Logger) bool {
	updated, _ := applyClaudeSkillsResult(context.Background(), items, logger)
	return updated
}

func applyClaudeSkillsResult(ctx context.Context, items []orchestrator.CollectionItem, logger *slog.Logger) (updated bool, resultErr error) {
	// nil means an older server omitted claude_skills entirely. An explicit
	// empty JSON array is non-nil and remains the authoritative signal to prune
	// fleet-managed skills that no longer exist.
	if items == nil {
		return false, nil
	}
	_, span := tracing.Start(ctx, "cxx.apply.claude_skills",
		tracing.String("wrapper.engine", "claude"),
		tracing.Int("wrapper.item_count", len(items)),
	)
	defer func() {
		span.SetBool("wrapper.updated", updated)
		span.Fail(resultErr)
		span.End()
	}()

	skillsRoot := claudeSubdir("skills")
	manPath := collectionManifestPath("skills")
	man := loadManifest(manPath)
	newItems := map[string]manifestEntry{}

	for _, it := range items {
		prev, recorded := man.Items[it.Slug]
		preservePrevious := func() {
			if recorded {
				newItems[it.Slug] = prev
			}
		}
		name := sanitizeSlug(it.Slug)
		if name == "" {
			logger.Warn("skipping skill with unsafe slug", "slug", it.Slug)
			resultErr = errors.Join(resultErr, fmt.Errorf("Claude skill %q has an unsafe slug", it.Slug))
			preservePrevious()
			continue
		}
		known := false
		if recorded {
			if _, valid := canonicalSkillOwnership(it.Slug, prev); !valid {
				logger.Warn("refusing skill with invalid ownership record", "slug", it.Slug, "filename", prev.Filename)
				resultErr = errors.Join(resultErr, fmt.Errorf("Claude skill %q has an invalid ownership record", it.Slug))
				preservePrevious()
				continue
			}
			known = true
		}
		skillDir := filepath.Join(skillsRoot, name)
		if !known && fileExists(skillDir) {
			// A directory that is absent from our ownership manifest belongs to the
			// user (or another tool). Never adopt, overwrite, or remove it merely
			// because the fleet later publishes the same slug.
			resultErr = errors.Join(resultErr, fmt.Errorf("Claude skill %q conflicts with an unmanaged local directory", it.Slug))
			continue
		}
		if known && prev.SHA256 == it.SHA256 && skillBundlePresent(skillDir, prev) {
			// If-None-Match: unchanged and the complete managed file set is
			// present — leave the directory untouched.
			newItems[it.Slug] = prev
			continue
		} else if it.Content != "" {
			written, err := replaceSkillBundle(skillsRoot, name, it)
			if err != nil {
				logger.Debug("skill write failed", "slug", it.Slug, "err", err)
				resultErr = errors.Join(resultErr, fmt.Errorf("write Claude skill %q: %w", it.Slug, err))
				preservePrevious()
				continue
			}
			updated = true
			newItems[it.Slug] = manifestEntry{
				Filename:       filepath.Join(name, "SKILL.md"),
				SHA256:         it.SHA256,
				ManifestSHA256: written.ManifestSHA256,
				Files:          written.Files,
				FileSHA256:     written.FileSHA256,
			}
			continue
		} else {
			resultErr = errors.Join(resultErr, fmt.Errorf("Claude skill %q is missing content", it.Slug))
			if known && !skillBundlePresent(skillDir, prev) {
				// Keep ownership (so prune/strip remain surgical) but clear the
				// advertised digest. The next bootstrap then receives the complete
				// bundle and heals the missing file.
				prev.SHA256 = ""
				newItems[it.Slug] = prev
			} else {
				preservePrevious()
			}
			continue
		}
	}

	for slug, rec := range man.Items {
		if _, stillPresent := newItems[slug]; stillPresent {
			continue
		}
		d := skillDirFromManifest(skillsRoot, slug, rec)
		if d == "" {
			newItems[slug] = rec
			resultErr = errors.Join(resultErr, fmt.Errorf("prune Claude skill %q: invalid ownership record", slug))
			continue
		}
		if err := os.RemoveAll(d); err != nil && !os.IsNotExist(err) {
			logger.Debug("skill prune failed", "slug", slug, "err", err)
			resultErr = errors.Join(resultErr, fmt.Errorf("prune Claude skill %q: %w", slug, err))
			// Keep ownership in the manifest so the next sync retries the prune.
			newItems[slug] = rec
			continue
		}
		updated = true
	}

	man.Items = newItems
	if err := saveManifest(manPath, man); err != nil {
		logger.Debug("skill manifest write failed", "err", err)
		resultErr = errors.Join(resultErr, fmt.Errorf("save Claude skill manifest: %w", err))
	}
	return updated, resultErr
}

// skillDirFromManifest resolves one canonical ownership record. The map key and
// Filename must name the same sanitized slug; accepting merely any safe filename
// would let a corrupted record for slug A authorize removing user-owned slug B.
func skillDirFromManifest(skillsRoot, slug string, rec manifestEntry) string {
	name, ok := canonicalSkillOwnership(slug, rec)
	if !ok {
		return ""
	}
	return filepath.Join(skillsRoot, name)
}

// skillDigestsForRequest advertises the on-disk skill shas for If-None-Match.
func skillDigestsForRequest() map[string]string {
	man := loadManifest(collectionManifestPath("skills"))
	out := map[string]string{}
	for slug, rec := range man.Items {
		name, ok := canonicalSkillOwnership(slug, rec)
		if !ok {
			continue
		}
		if !skillBundlePresent(filepath.Join(claudeSubdir("skills"), name), rec) {
			continue
		}
		out[slug] = rec.SHA256
	}
	return out
}

// stripClaudeSkills removes every fleet-written skill dir (trust-loss). Surgical:
// only manifest-recorded skill dirs, never the skills/ root or user dirs.
func stripClaudeSkills(logger *slog.Logger) error {
	return stripClaudeSkillsWith(logger, os.RemoveAll)
}

func stripClaudeSkillsWith(logger *slog.Logger, removeAll func(string) error) error {
	skillsRoot := claudeSubdir("skills")
	manPath := collectionManifestPath("skills")
	man := loadManifest(manPath)
	remaining := map[string]manifestEntry{}
	var resultErr error
	for slug, rec := range man.Items {
		d := skillDirFromManifest(skillsRoot, slug, rec)
		if d == "" {
			remaining[slug] = rec
			resultErr = errors.Join(resultErr, fmt.Errorf("strip Claude skill %q: unsafe manifest path", slug))
			continue
		}
		if err := removeAll(d); err != nil && !os.IsNotExist(err) {
			logger.Debug("skill strip failed", "slug", slug, "err", err)
			remaining[slug] = rec
			resultErr = errors.Join(resultErr, fmt.Errorf("strip Claude skill %q: %w", slug, err))
		}
	}
	if err := saveManifest(manPath, collectionManifest{Version: 1, Items: remaining}); err != nil {
		resultErr = errors.Join(resultErr, fmt.Errorf("save Claude skill ownership: %w", err))
	}
	return resultErr
}

// stripClaudeCollections removes every fleet-written collection file (used when
// a host loses trust). Surgical: only manifest-recorded files, never the dir.
func stripClaudeCollections(logger *slog.Logger) error {
	return stripClaudeCollectionsWith(logger, os.Remove)
}

func stripClaudeCollectionsWith(logger *slog.Logger, remove func(string) error) error {
	var resultErr error
	for _, dir := range artifactDirs {
		manPath := collectionManifestPath(dir)
		man := loadManifest(manPath)
		targetDir := claudeSubdir(dir)
		remaining := map[string]manifestEntry{}
		for slug, rec := range man.Items {
			name := sanitizeSlug(slug)
			if name == "" || rec.Filename != name+".md" {
				remaining[slug] = rec
				resultErr = errors.Join(resultErr, fmt.Errorf("strip Claude collection %s/%q: unsafe manifest path", dir, slug))
				continue
			}
			if err := remove(filepath.Join(targetDir, rec.Filename)); err != nil && !os.IsNotExist(err) {
				logger.Debug("collection strip failed", "dir", dir, "slug", slug, "err", err)
				remaining[slug] = rec
				resultErr = errors.Join(resultErr, fmt.Errorf("strip Claude collection %s/%q: %w", dir, slug, err))
			}
		}
		if err := saveManifest(manPath, collectionManifest{Version: 1, Items: remaining}); err != nil {
			resultErr = errors.Join(resultErr, fmt.Errorf("save Claude collection %s ownership: %w", dir, err))
		}
	}
	return resultErr
}
