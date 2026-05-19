// Package lifecycle — skills.go drives the orchestrator-side skills sync.
//
// v2 skills are read live via MCP (`resource_read skill://<slug>`) so the
// wrapper never persists the manifest bodies to disk. What it does is:
//
//  1. Probe `GET /skills?engine=claude` once per run, hash the
//     (slug, sha256, version) fingerprint of the list, and compare against
//     the cached digest under ~/.cache/codex-orchestrator/clx-skills-digest.
//     Any change marks the boot screen's "skills" dot as updated.
//  2. One-shot purge of legacy on-disk skill caches (`~/.agents/skills`,
//     `~/.clx/skills`, `~/.claude/skills`) the first time we boot at this
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

	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/orchestrator"
)

func skillsDigestPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".cache", "codex-orchestrator", "clx-skills-digest")
}

func legacyCleanupSentinel(version string) string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	if version == "" {
		version = "dev"
	}
	return filepath.Join(home, ".cache", "codex-orchestrator", "clx-cleanup-v"+version)
}

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

func pruneLegacySkillDirs(version string, logger *slog.Logger) {
	sentinel := legacyCleanupSentinel(version)
	if sentinel == "" {
		return
	}
	if _, err := os.Stat(sentinel); err == nil {
		return
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return
	}
	targets := []string{
		filepath.Join(home, ".agents", "skills"),
		filepath.Join(home, ".clx", "skills"),
		filepath.Join(home, ".claude", "skills"),
	}
	for _, t := range targets {
		if _, err := os.Stat(t); err != nil {
			continue
		}
		if err := os.RemoveAll(t); err != nil {
			logger.Debug("legacy skill dir prune failed", "path", t, "err", err)
			continue
		}
		logger.Debug("pruned legacy skill cache", "path", t)
	}
	_ = os.MkdirAll(filepath.Dir(sentinel), 0o700)
	_ = os.WriteFile(sentinel, []byte(version+"\n"), 0o600)
}
