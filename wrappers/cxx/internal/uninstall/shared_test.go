package uninstall

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPartialDeleteRemovesOnlySelectedAlias(t *testing.T) {
	result, err := DecodeServerResult(strings.NewReader(`{"deleted_engine":"claude","remaining_engines":["codex"]}`))
	if err != nil {
		t.Fatal(err)
	}
	if got := Decide(result); got != RemoveSelectedAlias {
		t.Fatalf("disposition=%v", got)
	}
}

func TestApplyPartialKeepsCXXRemainingAliasAndCron(t *testing.T) {
	dir := t.TempDir()
	cxx := filepath.Join(dir, "cxx")
	if err := os.WriteFile(cxx, []byte("common"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, alias := range []string{"cdx", "clx"} {
		if err := os.Symlink("cxx", filepath.Join(dir, alias)); err != nil {
			t.Fatal(err)
		}
	}
	if err := Apply(context.Background(), ServerResult{Confirmed: true, RemainingEngines: []string{"codex"}}, "claude", cxx); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(filepath.Join(dir, "clx")); !os.IsNotExist(err) {
		t.Fatalf("clx remains: %v", err)
	}
	for _, keep := range []string{"cxx", "cdx"} {
		if _, err := os.Lstat(filepath.Join(dir, keep)); err != nil {
			t.Fatalf("%s removed: %v", keep, err)
		}
	}
}

func TestApplyLastRemovesCXXAliasesAndCron(t *testing.T) {
	dir := t.TempDir()
	cxx := filepath.Join(dir, "cxx")
	if err := os.WriteFile(cxx, []byte("common"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, alias := range []string{"cdx", "clx"} {
		if err := os.Symlink("cxx", filepath.Join(dir, alias)); err != nil {
			t.Fatal(err)
		}
	}
	oldRemove := removeCron
	cronCalls := 0
	removeCron = func(context.Context) error { cronCalls++; return nil }
	t.Cleanup(func() { removeCron = oldRemove })
	if err := Apply(context.Background(), ServerResult{Confirmed: true, LastHost: true}, "claude", cxx); err != nil {
		t.Fatal(err)
	}
	if cronCalls != 1 {
		t.Fatalf("cron calls=%d", cronCalls)
	}
	for _, name := range []string{"cxx", "cdx", "clx"} {
		if _, err := os.Lstat(filepath.Join(dir, name)); !os.IsNotExist(err) {
			t.Fatalf("%s remains: %v", name, err)
		}
	}
}

func TestApplyUnconfirmedPreservesAllSharedArtifacts(t *testing.T) {
	dir := t.TempDir()
	cxx := filepath.Join(dir, "cxx")
	if err := os.WriteFile(cxx, []byte("common"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("cxx", filepath.Join(dir, "clx")); err != nil {
		t.Fatal(err)
	}
	if err := Apply(context.Background(), ServerResult{}, "claude", cxx); err != nil {
		t.Fatal(err)
	}
	for _, keep := range []string{"cxx", "clx"} {
		if _, err := os.Lstat(filepath.Join(dir, keep)); err != nil {
			t.Fatalf("%s removed: %v", keep, err)
		}
	}
}

func TestLastEngineDeleteRemovesAllShared(t *testing.T) {
	result, err := DecodeServerResult(strings.NewReader(`{"deleted":"host.example.com"}`))
	if err != nil {
		t.Fatal(err)
	}
	if got := Decide(result); got != RemoveAllShared {
		t.Fatalf("disposition=%v", got)
	}
}

func TestUnreachableOrUnconfirmedDeletePreservesShared(t *testing.T) {
	if got := Decide(ServerResult{}); got != PreserveShared {
		t.Fatalf("disposition=%v", got)
	}
	if _, err := DecodeServerResult(strings.NewReader(`{"status":"ok"}`)); err == nil {
		t.Fatal("unconfirmed response accepted")
	}
}

func TestDataEnvelopeIsAccepted(t *testing.T) {
	result, err := DecodeServerResult(strings.NewReader(`{"data":{"remaining_engines":["claude"]}}`))
	if err != nil || len(result.RemainingEngines) != 1 || result.RemainingEngines[0] != "claude" {
		t.Fatalf("result=%+v err=%v", result, err)
	}
}

func TestDeletedFalseIsNotLastHostConfirmation(t *testing.T) {
	if _, err := DecodeServerResult(strings.NewReader(`{"deleted":false}`)); err == nil {
		t.Fatal("deleted:false accepted")
	}
	if _, err := DecodeServerResult(strings.NewReader(`{"deleted":"false"}`)); err == nil {
		t.Fatal(`deleted:"false" accepted`)
	}
}

func TestPartialResponseIncludingSelectedEnginePreservesShared(t *testing.T) {
	dir := t.TempDir()
	cxx := filepath.Join(dir, "cxx")
	if err := os.WriteFile(cxx, []byte("common"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("cxx", filepath.Join(dir, "clx")); err != nil {
		t.Fatal(err)
	}
	err := Apply(context.Background(), ServerResult{Confirmed: true, RemainingEngines: []string{"claude", "codex"}}, "claude", cxx)
	if err == nil {
		t.Fatal("inconsistent partial result accepted")
	}
	for _, keep := range []string{"cxx", "clx"} {
		if _, statErr := os.Lstat(filepath.Join(dir, keep)); statErr != nil {
			t.Fatalf("%s removed after malformed response: %v", keep, statErr)
		}
	}
}

func TestUnknownRemainingEngineIsRejected(t *testing.T) {
	if _, err := DecodeServerResult(strings.NewReader(`{"remaining_engines":["codex","other"]}`)); err == nil {
		t.Fatal("unknown engine accepted")
	}
}

func TestConflictingDeleteStatesAreRejected(t *testing.T) {
	for _, body := range []string{
		`{"remaining_engines":["codex"],"deleted":true}`,
		`{"remaining_engines":["codex"],"data":{"remaining_engines":["claude"]}}`,
	} {
		if _, err := DecodeServerResult(strings.NewReader(body)); err == nil {
			t.Fatalf("conflicting response accepted: %s", body)
		}
	}
}

func TestDuplicatedEnvelopeStateIsAcceptedWhenIdentical(t *testing.T) {
	result, err := DecodeServerResult(strings.NewReader(`{"remaining_engines":["codex"],"data":{"remaining_engines":["codex"]}}`))
	if err != nil || len(result.RemainingEngines) != 1 || result.RemainingEngines[0] != "codex" {
		t.Fatalf("result=%+v err=%v", result, err)
	}
}

func TestApplyRejectsLastHostWithRemainingEngines(t *testing.T) {
	dir := t.TempDir()
	cxx := filepath.Join(dir, "cxx")
	if err := os.WriteFile(cxx, []byte("common"), 0o755); err != nil {
		t.Fatal(err)
	}
	result := ServerResult{Confirmed: true, LastHost: true, RemainingEngines: []string{"codex"}}
	if err := Apply(context.Background(), result, "claude", cxx); err == nil {
		t.Fatal("inconsistent last-host result accepted")
	}
	if _, err := os.Stat(cxx); err != nil {
		t.Fatalf("cxx removed after inconsistent result: %v", err)
	}
}
