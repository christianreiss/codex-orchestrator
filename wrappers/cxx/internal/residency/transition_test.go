package residency

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
)

type transitionFixture struct {
	staged, fenced, quiet, exited, installed, verified, released bool
	owner                                                        string
	failAt                                                       string
	calls                                                        []string
	ids                                                          []string
}

func (f *transitionFixture) call(name string, j Journal) error {
	f.calls = append(f.calls, name)
	f.ids = append(f.ids, j.TransitionID)
	if f.failAt == name {
		return errors.New("lost or failed " + name)
	}
	return nil
}
func (f *transitionFixture) Stage(_ context.Context, j Journal) error {
	if err := f.call("stage", j); err != nil {
		return err
	}
	f.staged = true
	return nil
}
func (f *transitionFixture) Fence(_ context.Context, j Journal) error {
	if !f.staged {
		return errors.New("unstaged")
	}
	if err := f.call("fence", j); err != nil {
		return err
	}
	f.fenced = true
	return nil
}
func (f *transitionFixture) Prepare(_ context.Context, j Journal) error {
	if err := f.call("prepare", j); err != nil {
		return err
	}
	if !f.fenced || !f.quiet {
		return errors.New("accepted work remains")
	}
	return nil
}
func (f *transitionFixture) Exit(_ context.Context, j Journal) error {
	if err := f.call("exit", j); err != nil {
		return err
	}
	if !f.exited {
		return errors.New("ACK without kernel exit")
	}
	return nil
}
func (f *transitionFixture) Install(_ context.Context, j Journal) (string, error) {
	if err := f.call("install", j); err != nil {
		return "", err
	}
	if !f.exited {
		return "", errors.New("source alive")
	}
	f.installed = true
	return f.owner, nil
}
func (f *transitionFixture) Verify(_ context.Context, j Journal) error {
	if err := f.call("verify", j); err != nil {
		return err
	}
	if !f.installed || !f.verified || j.TargetOwner != f.owner {
		return errors.New("target not verified")
	}
	return nil
}
func (f *transitionFixture) Release(_ context.Context, j Journal) error {
	if err := f.call("release", j); err != nil {
		return err
	}
	f.released = true
	return nil
}

func TestMigrationRecoveryRetainsFenceAndNeverInstallsAfterAcknowledgementAlone(t *testing.T) {
	path := filepath.Join(t.TempDir(), "private", "transition.json")
	j := Journal{TransitionID: uuid.NewString(), Source: strings.Repeat("a", 64), Target: strings.Repeat("b", 64), SourceOwner: uuid.NewString(), Phase: Observed}
	if err := CreateJournal(path, j); err != nil {
		t.Fatal(err)
	}
	fixture := &transitionFixture{owner: uuid.NewString()}
	result, err := ContinueTransition(context.Background(), path, fixture)
	if err == nil || result.Phase != Draining || !fixture.fenced || fixture.installed || fixture.released {
		t.Fatalf("busy migration advanced: %+v %v", result, err)
	}
	fixture.quiet = true
	result, err = ContinueTransition(context.Background(), path, fixture)
	if err == nil || result.Phase != HandoffReady || fixture.installed {
		t.Fatalf("ACK counted as exit: %+v %v", result, err)
	}
	fixture.exited = true
	result, err = ContinueTransition(context.Background(), path, fixture)
	if err == nil || result.Phase != Replaced || fixture.released {
		t.Fatalf("unverified target reopened: %+v %v", result, err)
	}
	fixture.verified = true
	fixture.failAt = "release"
	result, err = ContinueTransition(context.Background(), path, fixture)
	if err == nil || result.Phase != Verified {
		t.Fatalf("ambiguous release lost: %+v %v", result, err)
	}
	fixture.failAt = ""
	result, err = ContinueTransition(context.Background(), path, fixture)
	if err != nil || result.Phase != Reopened || !fixture.released {
		t.Fatalf("recovery failed: %+v %v", result, err)
	}
	installs := 0
	for i, call := range fixture.calls {
		if fixture.ids[i] != j.TransitionID {
			t.Fatal("retry used new transition identity")
		}
		if call == "install" {
			installs++
		}
	}
	if installs != 1 {
		t.Fatalf("replacement repeated %d times", installs)
	}
}
