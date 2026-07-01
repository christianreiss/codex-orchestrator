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
	dir, ok := artifactDirs[kind]
	if !ok {
		return false
	}
	targetDir := claudeSubdir(dir)
	man := loadManifest(collectionManifestPath(dir))
	newItems := map[string]manifestEntry{}
	updated := false

	for _, it := range items {
		name := sanitizeSlug(it.Slug)
		if name == "" {
			logger.Warn("skipping artifact with unsafe slug", "kind", kind, "slug", it.Slug)
			continue
		}
		path := filepath.Join(targetDir, name+".md")
		prev, known := man.Items[it.Slug]
		if known && prev.SHA256 == it.SHA256 && fileExists(path) {
			// If-None-Match: unchanged and present — leave it.
		} else if it.Content != "" {
			if err := atomicWrite(path, []byte(it.Content), 0o644); err != nil {
				logger.Debug("collection write failed", "kind", kind, "slug", it.Slug, "err", err)
				continue
			}
			updated = true
		} else if !fileExists(path) {
			// Server flagged a change but sent no content and we have no file —
			// nothing to write. Skip without recording so we re-request next run.
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
		}
		updated = true
	}

	man.Items = newItems
	if err := saveManifest(collectionManifestPath(dir), man); err != nil {
		logger.Debug("collection manifest write failed", "kind", kind, "err", err)
	}
	return updated
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
	skillsRoot := claudeSubdir("skills")
	manPath := collectionManifestPath("skills")
	man := loadManifest(manPath)
	newItems := map[string]manifestEntry{}
	updated := false

	for _, it := range items {
		name := sanitizeSlug(it.Slug)
		if name == "" {
			logger.Warn("skipping skill with unsafe slug", "slug", it.Slug)
			continue
		}
		path := filepath.Join(skillsRoot, name, "SKILL.md") // atomicWrite MkdirAll's <slug>/
		prev, known := man.Items[it.Slug]
		if known && prev.SHA256 == it.SHA256 && fileExists(path) {
			// If-None-Match: unchanged and present — leave it.
		} else if it.Content != "" {
			if err := atomicWrite(path, []byte(it.Content), 0o644); err != nil {
				logger.Debug("skill write failed", "slug", it.Slug, "err", err)
				continue
			}
			updated = true
		} else if !fileExists(path) {
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
			}
			updated = true
		}
	}

	man.Items = newItems
	if err := saveManifest(manPath, man); err != nil {
		logger.Debug("skill manifest write failed", "err", err)
	}
	return updated
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
func stripClaudeSkills(logger *slog.Logger) {
	skillsRoot := claudeSubdir("skills")
	manPath := collectionManifestPath("skills")
	man := loadManifest(manPath)
	for slug, rec := range man.Items {
		if d := skillDirFromManifest(skillsRoot, rec.Filename); d != "" {
			if err := os.RemoveAll(d); err != nil && !os.IsNotExist(err) {
				logger.Debug("skill strip failed", "slug", slug, "err", err)
			}
		}
	}
	_ = saveManifest(manPath, collectionManifest{Version: 1, Items: map[string]manifestEntry{}})
}

// stripClaudeCollections removes every fleet-written collection file (used when
// a host loses trust). Surgical: only manifest-recorded files, never the dir.
func stripClaudeCollections(logger *slog.Logger) {
	for _, dir := range artifactDirs {
		manPath := collectionManifestPath(dir)
		man := loadManifest(manPath)
		targetDir := claudeSubdir(dir)
		for slug, rec := range man.Items {
			if err := os.Remove(filepath.Join(targetDir, rec.Filename)); err != nil && !os.IsNotExist(err) {
				logger.Debug("collection strip failed", "dir", dir, "slug", slug, "err", err)
			}
		}
		_ = saveManifest(manPath, collectionManifest{Version: 1, Items: map[string]manifestEntry{}})
	}
}
