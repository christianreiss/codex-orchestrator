package residency

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestNamespacesConvergeDefaultsWithoutCollapsingCustomRoots(t *testing.T) {
	unset, err := Namespace(1000, "")
	if err != nil {
		t.Fatal(err)
	}
	logind, err := Namespace(1000, "/run/user/1000")
	if err != nil || unset != logind {
		t.Fatalf("default mismatch: %q %q %v", unset, logind, err)
	}
	first, _ := Namespace(1000, "/custom/"+strings.Repeat("a", 120))
	second, _ := Namespace(1000, "/custom/"+strings.Repeat("b", 120))
	if Key(1000, "https://co.example/", first) == Key(1000, "https://co.example", second) {
		t.Fatal("long roots collapsed")
	}
	if Key(1000, "https://co.example/", unset) != Key(1000, "https://co.example", logind) {
		t.Fatal("base trailing slash changed identity")
	}
	if Key(1000, "https://co.example", unset) == Key(1001, "https://co.example", unset) {
		t.Fatal("users collapsed")
	}
	if _, err := Namespace(1000, "relative"); err == nil {
		t.Fatal("relative namespace accepted")
	}
}

func TestEveryOutstandingWorkKindBlocksHandoff(t *testing.T) {
	work := []Workload{{Accepted: 1}, {PeerClaims: 1}, {Children: 1}, {Receipts: 1}, {Writes: 1}, {Requests: 1}, {LegacyClients: 1}, {Accepted: -1}}
	for _, w := range work {
		if w.Quiet() || !KeepResident(false, false, w) {
			t.Fatalf("outstanding work ignored: %+v", w)
		}
		if err := Next(Draining, HandoffReady, Evidence{AdmissionFenced: true, Workload: w}); err == nil {
			t.Fatalf("unsafe handoff accepted: %+v", w)
		}
	}
	if KeepResident(false, false, Workload{}) {
		t.Fatal("idle nonresident retained")
	}
	if !KeepResident(true, false, Workload{}) || !KeepResident(false, true, Workload{}) {
		t.Fatal("residence requires execution")
	}
}

func TestMigrationRequiresFenceExitLockAndTargetVerification(t *testing.T) {
	if err := Next(Staged, Fenced, Evidence{}); err == nil {
		t.Fatal("unfenced migration")
	}
	if err := Next(Observed, Replaced, Evidence{}); err == nil {
		t.Fatal("skipped states")
	}
	if err := Next(HandoffReady, Replaced, Evidence{AdmissionFenced: true}); err == nil {
		t.Fatal("disconnect counted as exit")
	}
	if err := Next(Verified, Reopened, Evidence{AdmissionFenced: true}); err == nil {
		t.Fatal("unverified admission reopened")
	}
	if err := Next(Draining, HandoffReady, Evidence{AdmissionFenced: true}); err == nil {
		t.Fatal("unknown workload counted as idle")
	}
	if err := Next("invalid", "", Evidence{AdmissionFenced: true}); err == nil {
		t.Fatal("unknown phase accepted")
	}
	e := Evidence{AdmissionFenced: true, WorkloadVerified: true, SourceExited: true, OwnerAcquired: true, TargetVerified: true}
	phases := []Phase{Observed, Staged, Fenced, Draining, HandoffReady, Replaced, Verified, Reopened}
	for i := 1; i < len(phases); i++ {
		if err := Next(phases[i-1], phases[i], e); err != nil {
			t.Fatal(err)
		}
	}
}

func TestJournalSurvivesRetryAndRejectsAnotherTransition(t *testing.T) {
	path := filepath.Join(t.TempDir(), "private", "migration.json")
	j := Journal{TransitionID: uuid.NewString(), Source: strings.Repeat("a", 64), Target: strings.Repeat("b", 64), SourceOwner: uuid.NewString(), Phase: Observed}
	if err := CreateJournal(path, j); err != nil {
		t.Fatal(err)
	}
	if err := CreateJournal(path, j); err != nil {
		t.Fatal("lost-ack retry", err)
	}
	next := j
	next.Phase = Staged
	if err := AdvanceJournal(path, j, next, Evidence{}); err != nil {
		t.Fatal(err)
	}
	if err := AdvanceJournal(path, j, next, Evidence{}); err != nil {
		t.Fatal("advance retry", err)
	}
	read, err := ReadJournal(path)
	if err != nil || read != next {
		t.Fatalf("journal recovery: %+v %v", read, err)
	}
	other := j
	other.TransitionID = uuid.NewString()
	if err := CreateJournal(path, other); err == nil {
		t.Fatal("new transition overwrote pending migration")
	}
	bad := next
	bad.Phase = Fenced
	if err := AdvanceJournal(path, next, bad, Evidence{}); err == nil {
		t.Fatal("journal bypassed fence")
	}
	if err := os.Chmod(path, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadJournal(path); err == nil {
		t.Fatal("unprotected journal accepted")
	}
}

func TestImmutableStagingVerifiesBytesAndRejectsSymlinks(t *testing.T) {
	source := filepath.Join(t.TempDir(), "running-cxx")
	if err := os.WriteFile(source, []byte("old binary"), 0755); err != nil {
		t.Fatal(err)
	}
	digest, _ := DigestFile(source)
	directory := filepath.Join(t.TempDir(), "staged")
	target, err := StageBinary(source, directory, digest)
	if err != nil {
		t.Fatal(err)
	}
	if again, err := StageBinary(source, directory, digest); err != nil || again != target {
		t.Fatalf("staging retry %q %v", again, err)
	}
	if err := os.WriteFile(source, []byte("new binary"), 0755); err != nil {
		t.Fatal(err)
	}
	got, _ := DigestFile(target)
	if got != digest {
		t.Fatal("running binary overwrite changed staged artifact")
	}
	if _, err := StageBinary(source, filepath.Join(t.TempDir(), "stage"), digest); err == nil {
		t.Fatal("wrong source accepted")
	}
	if err := os.Remove(target); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(source, target); err != nil {
		t.Fatal(err)
	}
	if _, err := StageBinary(source, directory, digest); err == nil {
		t.Fatal("staged symlink accepted")
	}
}
