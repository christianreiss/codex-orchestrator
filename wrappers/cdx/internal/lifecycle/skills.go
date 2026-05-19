// Package lifecycle — skills.go drives the orchestrator-side skills sync.
//
// v2 skills are read live via MCP (`resource_read skill://<slug>`) so the
// wrapper never persists the manifest bodies to disk. What it does is:
//
//  1. Probe `GET /skills?engine=codex` once per run, hash the (slug, sha256)
//     fingerprint of the list, and compare against the cached digest under
//     ~/.cache/codex-orchestrator/skills-digest. Any change marks the boot
//     screen's "skills" dot as updated.
//  2. One-shot purge of the legacy on-disk skill caches (`~/.agents/skills`,
//     `~/.codex/skills`, `~/.codex/prompts`) the first time we boot at this
//     wrapper version — they would otherwise shadow the MCP-served copies.
//
// Both operations are best-effort: any failure is logged at debug and the
// caller never refuses to launch over it.
package lifecycle

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/orchestrator"
)

func skillsDigestPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".cache", "codex-orchestrator", "skills-digest")
}

func legacyCleanupSentinel(version string) string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	if version == "" {
		version = "dev"
	}
	return filepath.Join(home, ".cache", "codex-orchestrator", "cleanup-v"+version)
}

// syncSkills pings /skills, fingerprints the result, and returns true when the
// fingerprint changed since the last run. Network failures, missing cache
// dirs, and empty server responses all return false — the boot screen falls
// back to the unchanged-dot.
func syncSkills(ctx context.Context, client *orchestrator.Client, logger *slog.Logger) bool {
	if client == nil {
		return false
	}
	list, err := client.ListSkills(ctx)
	if err != nil {
		logger.Debug("skills sync skipped", "err", err)
		return false
	}
	if len(list) == 0 {
		// Treat empty server-side list as the absence of a fingerprint — but
		// still write an empty cache so a later non-empty response registers
		// as a change.
		writeSkillsDigest("")
		return false
	}
	fp := fingerprintSkills(list)
	cached := readSkillsDigest()
	if fp == cached {
		return false
	}
	writeSkillsDigest(fp)
	return true
}

// fingerprintSkills builds a stable hex digest over the (slug, sha256) pairs
// in the server response. Order-independent: the list is sorted before hashing
// so the server's row order doesn't matter.
func fingerprintSkills(list []orchestrator.Skill) string {
	pairs := make([]string, 0, len(list))
	for _, s := range list {
		pairs = append(pairs, s.Slug+"|"+s.SHA256+"|"+s.Version)
	}
	sort.Strings(pairs)
	h := sha256.Sum256([]byte(strings.Join(pairs, "\n")))
	return hex.EncodeToString(h[:])
}

func readSkillsDigest() string {
	p := skillsDigestPath()
	if p == "" {
		return ""
	}
	raw, err := os.ReadFile(p)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(raw))
}

func writeSkillsDigest(fp string) {
	p := skillsDigestPath()
	if p == "" {
		return
	}
	_ = os.MkdirAll(filepath.Dir(p), 0o700)
	tmp := p + ".new"
	if err := os.WriteFile(tmp, []byte(fp+"\n"), 0o600); err != nil {
		return
	}
	_ = os.Rename(tmp, p)
}

// pruneLegacySkillDirs deletes the bash-era on-disk skill caches once per
// wrapper version (sentinel-gated). v2 reads skills via MCP only; leaving the
// old trees in place would let stale manifests shadow live ones.
func pruneLegacySkillDirs(version string, logger *slog.Logger) {
	sentinel := legacyCleanupSentinel(version)
	if sentinel == "" {
		return
	}
	if _, err := os.Stat(sentinel); err == nil {
		return // already cleaned for this wrapper version
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return
	}
	targets := []string{
		filepath.Join(home, ".agents", "skills"),
		filepath.Join(home, ".codex", "skills"),
		filepath.Join(home, ".codex", "prompts"),
	}
	for _, t := range targets {
		if _, err := os.Stat(t); err != nil {
			continue
		}
		if err := os.RemoveAll(t); err != nil {
			logger.Debug("legacy skill dir prune failed", "path", t, "err", err)
			continue
		}
		logger.Info("pruned legacy skill cache", "path", t)
	}
	// Drop the sentinel last so a partial prune still retries next run.
	_ = os.MkdirAll(filepath.Dir(sentinel), 0o700)
	_ = os.WriteFile(sentinel, []byte(version+"\n"), 0o600)
}
