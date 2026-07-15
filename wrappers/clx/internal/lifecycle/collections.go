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
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/orchestrator"
)

// artifactDirs maps a collection kind to its ~/.claude subdirectory.
var artifactDirs = map[string]string{
	"subagent":     "agents",
	"command":      "commands",
	"output-style": "output-styles",
}

type manifestEntry struct {
	Filename string `json:"filename"`
	SHA256   string `json:"sha256"`
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

// applyCollection writes/prunes one collection kind and returns whether anything
// changed on disk.
func applyCollection(kind string, items []orchestrator.CollectionItem, logger *slog.Logger) bool {
	updated, _ := applyCollectionResult(kind, items, logger)
	return updated
}

func applyCollectionResult(kind string, items []orchestrator.CollectionItem, logger *slog.Logger) (bool, error) {
	dir, ok := artifactDirs[kind]
	if !ok {
		return false, fmt.Errorf("unknown Claude collection kind %q", kind)
	}
	targetDir := claudeSubdir(dir)
	man := loadManifest(collectionManifestPath(dir))
	newItems := map[string]manifestEntry{}
	updated := false
	var resultErr error

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

// applyClaudeArtifacts writes all three collection kinds. Returns true if any
// file changed (used to light the boot-screen dot).
func applyClaudeArtifacts(ca *orchestrator.ClaudeArtifacts, logger *slog.Logger) bool {
	if ca == nil {
		return false
	}
	u := applyCollection("subagent", ca.Subagents, logger)
	u = applyCollection("command", ca.Commands, logger) || u
	u = applyCollection("output-style", ca.OutputStyles, logger) || u
	return u
}

func applyClaudeArtifactsResult(ca *orchestrator.ClaudeArtifacts, logger *slog.Logger) (bool, error) {
	if ca == nil {
		return false, nil
	}
	updated, resultErr := applyCollectionResult("subagent", ca.Subagents, logger)
	changed, err := applyCollectionResult("command", ca.Commands, logger)
	updated = updated || changed
	resultErr = errors.Join(resultErr, err)
	changed, err = applyCollectionResult("output-style", ca.OutputStyles, logger)
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
	updated, _ := applyClaudeSkillsResult(items, logger)
	return updated
}

func applyClaudeSkillsResult(items []orchestrator.CollectionItem, logger *slog.Logger) (bool, error) {
	// nil means an older server omitted claude_skills entirely. An explicit
	// empty JSON array is non-nil and remains the authoritative signal to prune
	// fleet-managed skills that no longer exist.
	if items == nil {
		return false, nil
	}
	skillsRoot := claudeSubdir("skills")
	manPath := collectionManifestPath("skills")
	man := loadManifest(manPath)
	newItems := map[string]manifestEntry{}
	updated := false
	var resultErr error

	for _, it := range items {
		prev, known := man.Items[it.Slug]
		preservePrevious := func() {
			if known {
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
		path := filepath.Join(skillsRoot, name, "SKILL.md") // atomicWrite MkdirAll's <slug>/
		if known && prev.SHA256 == it.SHA256 && fileExists(path) {
			// If-None-Match: unchanged and present — leave it.
		} else if it.Content != "" {
			if err := atomicWrite(path, []byte(it.Content), 0o644); err != nil {
				logger.Debug("skill write failed", "slug", it.Slug, "err", err)
				resultErr = errors.Join(resultErr, fmt.Errorf("write Claude skill %q: %w", it.Slug, err))
				preservePrevious()
				continue
			}
			updated = true
		} else {
			resultErr = errors.Join(resultErr, fmt.Errorf("Claude skill %q is missing content", it.Slug))
			preservePrevious()
			continue
		}
		newItems[it.Slug] = manifestEntry{Filename: filepath.Join(name, "SKILL.md"), SHA256: it.SHA256}
	}

	for slug, rec := range man.Items {
		if _, stillPresent := newItems[slug]; stillPresent {
			continue
		}
		if d := skillDirFromManifest(skillsRoot, rec.Filename); d != "" {
			if err := os.RemoveAll(d); err != nil && !os.IsNotExist(err) {
				logger.Debug("skill prune failed", "slug", slug, "err", err)
				resultErr = errors.Join(resultErr, fmt.Errorf("prune Claude skill %q: %w", slug, err))
				// Keep ownership in the manifest so the next sync retries the prune.
				newItems[slug] = rec
				continue
			}
			updated = true
		}
	}

	man.Items = newItems
	if err := saveManifest(manPath, man); err != nil {
		logger.Debug("skill manifest write failed", "err", err)
		resultErr = errors.Join(resultErr, fmt.Errorf("save Claude skill manifest: %w", err))
	}
	return updated, resultErr
}

// skillDirFromManifest resolves the absolute skill directory for a manifest
// Filename ("<slug>/SKILL.md"). Returns "" (and the caller skips) unless the
// path is exactly one sanitized slug deep — guarding against ever RemoveAll-ing
// the whole ~/.claude/skills tree or escaping it.
func skillDirFromManifest(skillsRoot, filename string) string {
	sub := filepath.Dir(filename)
	if sub == "." || sub == "" || sub == string(filepath.Separator) {
		return ""
	}
	if name := sanitizeSlug(sub); name == "" || name != sub {
		return ""
	}
	return filepath.Join(skillsRoot, sub)
}

// skillDigestsForRequest advertises the on-disk skill shas for If-None-Match.
func skillDigestsForRequest() map[string]string {
	man := loadManifest(collectionManifestPath("skills"))
	out := map[string]string{}
	for slug, rec := range man.Items {
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
		d := skillDirFromManifest(skillsRoot, rec.Filename)
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
