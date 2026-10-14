package communicator

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMalformedPendingGenerationNeverLooksAbsent(t *testing.T) {
	for _, raw := range []string{"null", "{}", `{"generation":""}`, `{"generation":"short"}`, `{"generation":5}`, `{"generation":"` + strings.Repeat("g", 64) + `"}`, `{"generation":"` + strings.Repeat("A", 64) + `"}`} {
		t.Run(raw, func(t *testing.T) {
			job := fixtureJob(t, "codex")
			if err := os.MkdirAll(jobHome(job), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(pendingPath(job), []byte(raw), 0600); err != nil {
				t.Fatal(err)
			}
			if got := pendingGeneration(job); got != "invalid" {
				t.Fatalf("malformed fence looked resolved or obsolete: %q", got)
			}
		})
	}
}

func TestPendingUploadStillFencesLegacyTransportAfterRollback(t *testing.T) {
	t.Setenv("CXX_COMMUNICATOR_SYNC", "")
	job := fixtureJob(t, "codex")
	if err := os.MkdirAll(filepath.Dir(job.AuthPath), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(job.AuthPath, []byte("fixture native bytes"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := writePending(job, fileGeneration(job.AuthPath)); err != nil {
		t.Fatal(err)
	}
	if !PendingAuth("https://rollback-fixture.invalid", "codex", job.AuthPath) {
		t.Fatal("signed rollback/no endpoint made unresolved upload replayable")
	}
}

func TestInvalidPendingGenerationCannotBePersisted(t *testing.T) {
	job := fixtureJob(t, "claude")
	if err := writePending(job, ""); err == nil {
		t.Fatal("persisted an absent-looking fence")
	}
	if _, err := os.Stat(jobHome(job)); !os.IsNotExist(err) {
		t.Fatal("mutated home before checking generation")
	}
}
