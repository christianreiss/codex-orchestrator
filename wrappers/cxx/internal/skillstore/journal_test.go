package skillstore

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
)

func TestSkillPublicationSurvivesKilledWriter(t *testing.T) {
	const modeKey = "CXX_SKILL_CRASH_PHASE"
	if mode := os.Getenv(modeKey); mode != "" {
		root := os.Getenv("CXX_SKILL_TEST_ROOT")
		s := Store{Root: filepath.Join(root, "skills"), ManifestPath: filepath.Join(root, "state", "skills.json"), Label: "test"}
		item := plain("sample", "new skill")
		_, err := replaceBundle(s.Root, item.Slug, item, func(stage string, out written) (bool, error) {
			rec := entry{Filename: filepath.Join(item.Slug, "SKILL.md"), SHA256: item.SHA256, ManifestSHA256: out.manifestSHA256, Files: out.files, FileSHA256: out.fileSHA256}
			if err := s.preparePending(item.Slug, stage, rec); err != nil {
				return false, err
			}
			if mode == "prepared" {
				_ = syscall.Kill(os.Getpid(), syscall.SIGKILL)
				select {}
			}
			return exists(filepath.Join(s.Root, item.Slug)), nil
		})
		if err != nil {
			t.Fatal(err)
		}
		_ = syscall.Kill(os.Getpid(), syscall.SIGKILL)
		select {}
	}
	for _, phase := range []string{"prepared", "published", "replacement"} {
		t.Run(phase, func(t *testing.T) {
			dir := t.TempDir()
			s := Store{Root: filepath.Join(dir, "skills"), ManifestPath: filepath.Join(dir, "state", "skills.json"), Label: "test"}
			if phase == "replacement" {
				if _, err := s.Apply([]Item{plain("sample", "old skill")}); err != nil {
					t.Fatal(err)
				}
			}
			cmd := exec.Command(os.Args[0], "-test.run=^TestSkillPublicationSurvivesKilledWriter$")
			cmd.Env = append(os.Environ(), modeKey+"="+phase, "CXX_SKILL_TEST_ROOT="+dir)
			out, err := cmd.CombinedOutput()
			var exitErr *exec.ExitError
			if !errors.As(err, &exitErr) {
				t.Fatalf("writer did not exit by signal: %v %s", err, out)
			}
			status, ok := exitErr.Sys().(syscall.WaitStatus)
			if !ok || !status.Signaled() || status.Signal() != syscall.SIGKILL {
				t.Fatalf("expected SIGKILL, got %v: %s", err, out)
			}
			if !exists(s.ManifestPath + ".pending") {
				t.Fatal("missing durable publication intent")
			}
			if _, err := s.Apply([]Item{plain("sample", "new skill")}); err != nil {
				t.Fatal("orphan not recovered", err)
			}
			if got := read(t, filepath.Join(s.Root, "sample", "SKILL.md")); got != "new skill" {
				t.Fatal(got)
			}
			if s.Digests()["sample"] != digest("new skill") {
				t.Fatal("ownership not repaired")
			}
			if exists(s.ManifestPath + ".pending") {
				t.Fatal("pending intent not cleared")
			}
		})
	}
}

func TestPendingPublicationNeverAdoptsSameContentUserDirectory(t *testing.T) {
	s := newStore(t)
	item := plain("sample", "fleet")
	_, err := replaceBundle(s.Root, item.Slug, item, func(stage string, out written) (bool, error) {
		rec := entry{Filename: filepath.Join(item.Slug, "SKILL.md"), SHA256: item.SHA256, ManifestSHA256: out.manifestSHA256, Files: out.files, FileSHA256: out.fileSHA256}
		if err := s.preparePending(item.Slug, stage, rec); err != nil {
			return false, err
		}
		target := filepath.Join(s.Root, item.Slug)
		if err := os.Mkdir(target, 0755); err != nil {
			return false, err
		}
		if err := os.WriteFile(filepath.Join(target, "SKILL.md"), []byte(item.Content), 0644); err != nil {
			return false, err
		}
		return false, nil
	})
	if err == nil {
		t.Fatal("foreign directory replaced")
	}
	if _, err = s.Apply([]Item{item}); err == nil {
		t.Fatal("same-content user skill adopted")
	}
	if s.Count() != 0 {
		t.Fatal("foreign directory recorded as owned")
	}
	if got := read(t, filepath.Join(s.Root, "sample", "SKILL.md")); got != "fleet" {
		t.Fatal(got)
	}
}
