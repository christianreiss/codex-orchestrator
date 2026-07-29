package cron

import (
	"context"
	"errors"
	"io"
	"os"
	"os/user"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/fleetconfig"
)

func TestStripManagedMigratesAllWrapperMarkers(t *testing.T) {
	body := strings.Join([]string{
		"MAILTO=ops@example.com",
		"1 1 * * * /usr/bin/cdx --cron run # cdx-managed-cron",
		"2 2 * * * /usr/bin/clx --cron run # clx-managed-cron",
		"3 3 * * * /usr/bin/cxx cron run # cxx-managed-cron",
	}, "\n")
	got := stripManaged(body)
	if len(got) != 1 || got[0] != "MAILTO=ops@example.com" {
		t.Fatalf("stripManaged=%q", got)
	}
}

func TestFirstRunScheduleCollapseProducesOneSharedEntry(t *testing.T) {
	legacy := "1 1 * * * cdx --cron run # cdx-managed-cron\n2 2 * * * clx --cron run # clx-managed-cron\n"
	lines := stripManaged(legacy)
	lines = append(lines, buildCronLine(3, 1, "/usr/local/bin/cxx", "/tmp/cxx.log"))
	body := strings.Join(lines, "\n")
	if strings.Count(body, Marker) != 1 || strings.Contains(body, "cdx-managed-cron") || strings.Contains(body, "clx-managed-cron") {
		t.Fatalf("collapsed schedule=%q", body)
	}
}

func TestStripManagedBodyPreservesUnrelatedBytesAndMatchesMarkerSuffix(t *testing.T) {
	body := "# docs mention # cdx-managed-cron in prose\n\n" +
		"1 1 * * * cdx --cron # cdx-managed-cron  \n" +
		"MAILTO=ops@example.com"
	got, changed := stripManagedBody(body)
	if !changed {
		t.Fatal("managed line was not removed")
	}
	want := "# docs mention # cdx-managed-cron in prose\n\nMAILTO=ops@example.com"
	if got != want {
		t.Fatalf("body=%q want=%q", got, want)
	}
}

func TestValidateEnabledConfigsAllowsStaleAndRollingWrapperMetadata(t *testing.T) {
	host := config.Host{ID: 7, FQDN: "host.example.com"}
	codexCfg := &config.Config{Engine: config.EngineCodex, Host: host, Wrapper: config.Wrapper{Version: "0.6.55", BinarySHA256: strings.Repeat("a", 64)}}
	claudeCfg := &config.Config{Engine: config.EngineClaude, Host: host, Wrapper: config.Wrapper{Version: "0.7.0", BinarySHA256: strings.Repeat("b", 64)}}
	byEngine := map[string]*config.Config{config.EngineCodex: codexCfg, config.EngineClaude: claudeCfg}
	if err := validateEnabledConfigs(byEngine, codexCfg, []string{config.EngineCodex, config.EngineClaude}); err != nil {
		t.Fatalf("rolling wrapper metadata rejected: %v", err)
	}
}

func TestCanWriteBinaryDoesNotOpenExecutingStyleFileForWrite(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "cxx")
	if err := os.WriteFile(path, []byte("executable"), 0o755); err != nil {
		t.Fatal(err)
	}
	if !canWriteBinary(path) {
		t.Fatal("user-owned executable should use user cron")
	}
}

func TestBuildCronLineUsesCanonicalCommandAndMarker(t *testing.T) {
	got := buildCronLine(17, 2, "/opt/cxx bin/cxx", "/tmp/cxx cron.log")
	for _, want := range []string{"17 2 * * *", "'/opt/cxx bin/cxx' cron run", "# cxx-managed-cron"} {
		if !strings.Contains(got, want) {
			t.Fatalf("line=%q missing %q", got, want)
		}
	}
}

func TestSetEnvReplacesWithoutDuplicating(t *testing.T) {
	got := setEnv([]string{"A=1", EngineOnlyEnv + "=0"}, EngineOnlyEnv, "1")
	if strings.Join(got, ",") != "A=1,"+EngineOnlyEnv+"=1" {
		t.Fatalf("env=%q", got)
	}
}

func TestAuthoritativeDualToSingleRemovesOnlyDisabledEngineState(t *testing.T) {
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
	host := config.Host{ID: 7, FQDN: "host.example.com"}
	seed := &config.Config{Engine: config.EngineClaude, Host: host}
	codexCfg := &config.Config{Engine: config.EngineCodex, Host: host}

	oldFetch, oldPersist, oldRemove := fetchAuthoritative, persistAuthoritative, removeEngineConfig
	var persisted, removed []string
	fetchAuthoritative = func(_ context.Context, _ *config.Config, engine string) (*fleetconfig.Fetched, error) {
		if engine == config.EngineClaude {
			return nil, fleetconfig.ErrEngineDisabled
		}
		return &fleetconfig.Fetched{Config: codexCfg}, nil
	}
	persistAuthoritative = func(_ context.Context, item *fleetconfig.Fetched) error {
		persisted = append(persisted, item.Config.Engine)
		return nil
	}
	removeEngineConfig = func(_ context.Context, engine string) error {
		removed = append(removed, engine)
		return nil
	}
	t.Cleanup(func() {
		fetchAuthoritative, persistAuthoritative, removeEngineConfig = oldFetch, oldPersist, oldRemove
	})

	_, engines, canonical, err := refreshAuthoritative(context.Background(), seed, cxx)
	if err != nil {
		t.Fatal(err)
	}
	if canonical != cxx || !reflect.DeepEqual(engines, []string{config.EngineCodex}) {
		t.Fatalf("canonical=%q engines=%q", canonical, engines)
	}
	if !reflect.DeepEqual(persisted, []string{config.EngineCodex}) || !reflect.DeepEqual(removed, []string{config.EngineClaude}) {
		t.Fatalf("persisted=%q removed=%q", persisted, removed)
	}
	if _, err := os.Lstat(filepath.Join(dir, "clx")); !os.IsNotExist(err) {
		t.Fatalf("disabled clx alias remains: %v", err)
	}
	if target, err := os.Readlink(filepath.Join(dir, "cdx")); err != nil || target != "cxx" {
		t.Fatalf("enabled cdx target=%q err=%v", target, err)
	}
}

func TestAuthoritativeProbeFailurePreservesDualLayout(t *testing.T) {
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
	seed := &config.Config{Engine: config.EngineCodex, Host: config.Host{ID: 7, FQDN: "host.example.com"}}
	oldFetch := fetchAuthoritative
	fetchAuthoritative = func(_ context.Context, _ *config.Config, engine string) (*fleetconfig.Fetched, error) {
		if engine == config.EngineCodex {
			return &fleetconfig.Fetched{Config: seed}, nil
		}
		return nil, errors.New("network down")
	}
	t.Cleanup(func() { fetchAuthoritative = oldFetch })
	if _, _, _, err := refreshAuthoritative(context.Background(), seed, cxx); err == nil {
		t.Fatal("network uncertainty accepted")
	}
	for _, alias := range []string{"cdx", "clx"} {
		if target, err := os.Readlink(filepath.Join(dir, alias)); err != nil || target != "cxx" {
			t.Fatalf("%s changed: target=%q err=%v", alias, target, err)
		}
	}
}

func TestAuthoritativeEmptyFetchFailsClosed(t *testing.T) {
	dir := t.TempDir()
	cxx := filepath.Join(dir, "cxx")
	if err := os.WriteFile(cxx, []byte("common"), 0o755); err != nil {
		t.Fatal(err)
	}
	seed := &config.Config{Engine: config.EngineCodex, Host: config.Host{ID: 7, FQDN: "host.example.com"}}
	oldFetch := fetchAuthoritative
	fetchAuthoritative = func(_ context.Context, _ *config.Config, engine string) (*fleetconfig.Fetched, error) {
		if engine == config.EngineCodex {
			return nil, nil
		}
		return nil, fleetconfig.ErrEngineDisabled
	}
	t.Cleanup(func() { fetchAuthoritative = oldFetch })
	if _, _, _, err := refreshAuthoritative(context.Background(), seed, cxx); err == nil || !strings.Contains(err.Error(), "empty config") {
		t.Fatalf("empty authoritative result accepted: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(dir, "cdx")); !os.IsNotExist(err) {
		t.Fatalf("alias created after empty result: %v", err)
	}
}

func TestRunEnabledTicksContinuesAfterFirstFailureAndRunsEachOnce(t *testing.T) {
	old := runEngineTick
	var calls []string
	runEngineTick = func(_ context.Context, _ string, args, env []string, _, _ io.Writer) error {
		calls = append(calls, args[0])
		joined := strings.Join(env, "\n")
		if !strings.Contains(joined, EngineOnlyEnv+"=1") || !strings.Contains(joined, CoordinatedEnv+"=1") {
			t.Fatalf("coordinator env missing: %q", env)
		}
		if args[0] == config.EngineCodex {
			return errors.New("codex failed")
		}
		return nil
	}
	t.Cleanup(func() { runEngineTick = old })
	err := runEnabledTicks(context.Background(), "/tmp/cxx", []string{config.EngineCodex, config.EngineClaude}, false, io.Discard, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "codex maintenance tick") {
		t.Fatalf("error=%v", err)
	}
	if !reflect.DeepEqual(calls, []string{config.EngineCodex, config.EngineClaude}) {
		t.Fatalf("calls=%q", calls)
	}
}

func TestSystemCronBodyPinsQuotedOverridesAndInstallUser(t *testing.T) {
	body := buildSystemCronBody("/opt/cxx bin/cxx", "/home/a b/cdx.json", "/home/a b/clx.json", "/home/a b/.cxx/cron.log", "alice", "/home/a b", 7, 3)
	for _, want := range []string{
		"HOME='/home/a b'",
		"CDX_CONFIG_PATH='/home/a b/cdx.json'",
		"CLX_CONFIG_PATH='/home/a b/clx.json'",
		"7 3 * * * alice '/opt/cxx bin/cxx' cron run",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("body missing %q:\n%s", want, body)
		}
	}
}

func TestSystemCronBodyEscapesPercentInCommandPaths(t *testing.T) {
	body := buildSystemCronBody("/opt/50% cxx/cxx", "/home/a/cdx.json", "/home/a/clx.json", "/home/a/50% cron.log", "alice", "/home/a", 7, 3)
	if strings.Count(body, `\%`) != 2 {
		t.Fatalf("command percents were not escaped:\n%s", body)
	}
	if !strings.Contains(body, Marker) {
		t.Fatalf("system marker missing:\n%s", body)
	}
}

func TestResolveCronConfigPathsPreservesOverridesAndInfersPeer(t *testing.T) {
	t.Setenv("CDX_CONFIG_PATH", "/srv/cxx config/cdx.json")
	t.Setenv("CLX_CONFIG_PATH", "")
	cdx, clx, err := resolveCronConfigPaths("/home/alice")
	if err != nil {
		t.Fatal(err)
	}
	if cdx != "/srv/cxx config/cdx.json" || clx != "/srv/cxx config/clx.json" {
		t.Fatalf("cdx=%q clx=%q", cdx, clx)
	}
}

func TestDirectRootStyleCronWriteIsAtomicWithoutSudo(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cxx-managed")
	if err := os.WriteFile(path, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	old := runCronSudo
	runCronSudo = func(...string) ([]byte, error) { return nil, syscall.EPERM }
	t.Cleanup(func() { runCronSudo = old })
	if err := writeManagedFileAtomic(path, []byte("new\n"), false); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(path); string(got) != "new\n" {
		t.Fatalf("body=%q", got)
	}
}

func TestPrivilegedCronWriteStagesAndMovesWithoutTee(t *testing.T) {
	old := runCronSudo
	var calls [][]string
	runCronSudo = func(args ...string) ([]byte, error) {
		calls = append(calls, append([]string(nil), args...))
		return nil, nil
	}
	t.Cleanup(func() { runCronSudo = old })
	path := filepath.Join(t.TempDir(), "cxx-managed")
	if err := writeManagedFileAtomic(path, []byte("body"), true); err != nil {
		t.Fatal(err)
	}
	if len(calls) < 2 || calls[0][0] != "install" || calls[1][0] != "mv" {
		t.Fatalf("calls=%q", calls)
	}
	for _, call := range calls {
		if call[0] == "tee" {
			t.Fatalf("non-atomic tee used: %q", calls)
		}
	}
}

func TestEnsureCronLogCreatesReadableFile(t *testing.T) {
	home := t.TempDir()
	logFile := filepath.Join(home, ".cxx", "cron.log")
	if err := ensureCronLog(logFile, home); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(logFile)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o644 {
		t.Fatalf("log mode=%#o", got)
	}
}

func TestSystemScheduleCleanupFailureRollsBackNewSharedEntry(t *testing.T) {
	oldInstall, oldReconcile := installSystemSchedule, reconcileUserSchedules
	oldLegacy, oldRemove := removeLegacySchedules, removeSystemSchedule
	var calls []string
	installSystemSchedule = func(string, int, int) error { calls = append(calls, "install"); return nil }
	reconcileUserSchedules = func() (userCrontabRollback, error) {
		calls = append(calls, "reconcile-users")
		return nil, errors.New("user cleanup failed")
	}
	removeLegacySchedules = func() error { calls = append(calls, "remove-legacy"); return nil }
	removeSystemSchedule = func(path string) error { calls = append(calls, "rollback:"+path); return nil }
	t.Cleanup(func() {
		installSystemSchedule, reconcileUserSchedules = oldInstall, oldReconcile
		removeLegacySchedules, removeSystemSchedule = oldLegacy, oldRemove
	})
	if err := reconcileSystemSchedule("/usr/local/bin/cxx", 1, 2); err == nil {
		t.Fatal("cleanup failure hidden")
	}
	want := []string{"install", "reconcile-users", "rollback:" + systemCronPath}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("calls=%q want=%q", calls, want)
	}
}

func TestSystemLegacyCleanupFailureRestoresUsersBeforeSharedRollback(t *testing.T) {
	oldInstall, oldReconcile := installSystemSchedule, reconcileUserSchedules
	oldLegacy, oldRemove := removeLegacySchedules, removeSystemSchedule
	var calls []string
	installSystemSchedule = func(string, int, int) error { calls = append(calls, "install"); return nil }
	reconcileUserSchedules = func() (userCrontabRollback, error) {
		calls = append(calls, "reconcile-users")
		return func() error { calls = append(calls, "restore-users"); return nil }, nil
	}
	removeLegacySchedules = func() error { calls = append(calls, "remove-legacy"); return errors.New("legacy cleanup failed") }
	removeSystemSchedule = func(path string) error { calls = append(calls, "rollback:"+path); return nil }
	t.Cleanup(func() {
		installSystemSchedule, reconcileUserSchedules = oldInstall, oldReconcile
		removeLegacySchedules, removeSystemSchedule = oldLegacy, oldRemove
	})
	if err := reconcileSystemSchedule("/usr/local/bin/cxx", 1, 2); err == nil {
		t.Fatal("legacy cleanup failure hidden")
	}
	want := []string{"install", "reconcile-users", "remove-legacy", "restore-users", "rollback:" + systemCronPath}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("calls=%q want=%q", calls, want)
	}
}

func TestDiscoverCrontabOwnersIncludesOtherUserOnDirectRootSchedule(t *testing.T) {
	spool := t.TempDir()
	for _, name := range []string{"root", "chris"} {
		if err := os.WriteFile(filepath.Join(spool, name), nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}

	oldDirs := userCrontabSpoolDirs
	oldLookup, oldCurrent, oldIdentity := lookupCrontabUser, currentCrontabUser, resolveCronIdentity
	userCrontabSpoolDirs = []string{spool}
	lookupCrontabUser = func(name string) (*user.User, error) {
		// Simulate a static binary on an NSS/SSSD host: root is local, while
		// chris owns a real protected spool file but is absent from /etc/passwd.
		if name != "root" {
			return nil, user.UnknownUserError(name)
		}
		return &user.User{Username: name, HomeDir: "/home/" + name}, nil
	}
	currentCrontabUser = func() (*user.User, error) { return &user.User{Username: "root"}, nil }
	resolveCronIdentity = func() (systemCronIdentity, error) {
		return systemCronIdentity{userName: "root", home: "/root"}, nil
	}
	t.Cleanup(func() {
		userCrontabSpoolDirs = oldDirs
		lookupCrontabUser, currentCrontabUser, resolveCronIdentity = oldLookup, oldCurrent, oldIdentity
	})

	owners, err := discoverManagedCrontabOwners()
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"chris", "root"}; !reflect.DeepEqual(owners, want) {
		t.Fatalf("owners=%q want=%q", owners, want)
	}
}

func TestValidCrontabOwnerNameRejectsOptionAndHiddenEntries(t *testing.T) {
	for _, candidate := range []string{"", "-root", ".placeholder", "bad/name", "bad name", "bad\nname"} {
		if validCrontabOwnerName(candidate) {
			t.Fatalf("unsafe spool owner accepted: %q", candidate)
		}
	}
	for _, candidate := range []string{"root", "chris", "user@example.com", "domain\\user"} {
		if !validCrontabOwnerName(candidate) {
			t.Fatalf("valid spool owner rejected: %q", candidate)
		}
	}
}

func TestReconcileManagedUserCrontabsRemovesOtherUserMarkerAndCanRollback(t *testing.T) {
	oldDiscover, oldRead, oldWrite := discoverCrontabOwners, readUserCrontab, writeUserCrontab
	bodies := map[string]string{
		"chris": "37 2 * * * /usr/local/bin/cdx --cron # cdx-managed-cron\n",
		"root":  "# Puppet Name: puppet\n45 * * * * /usr/local/sbin/runPuppet.sh\n",
	}
	discoverCrontabOwners = func() ([]string, error) { return []string{"chris", "root"}, nil }
	readUserCrontab = func(name string) (string, error) { return bodies[name], nil }
	var writes []string
	writeUserCrontab = func(name, body string) error {
		writes = append(writes, name+":"+body)
		bodies[name] = body
		return nil
	}
	t.Cleanup(func() {
		discoverCrontabOwners, readUserCrontab, writeUserCrontab = oldDiscover, oldRead, oldWrite
	})

	rollback, err := reconcileManagedUserCrontabs()
	if err != nil {
		t.Fatal(err)
	}
	if bodies["chris"] != "" {
		t.Fatalf("stale other-user entry remains: %q", bodies["chris"])
	}
	if len(writes) != 1 || !strings.HasPrefix(writes[0], "chris:") {
		t.Fatalf("unexpected writes=%q", writes)
	}
	if err := rollback(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(bodies["chris"], "# cdx-managed-cron") {
		t.Fatalf("rollback did not restore chris: %q", bodies["chris"])
	}
}

func TestReconcileManagedUserCrontabsRestoresEarlierWritesOnPartialFailure(t *testing.T) {
	oldDiscover, oldRead, oldWrite := discoverCrontabOwners, readUserCrontab, writeUserCrontab
	original := map[string]string{
		"alice": "A\n1 1 * * * cdx --cron # cdx-managed-cron\n",
		"bob":   "B\n2 2 * * * clx --cron # clx-managed-cron\n",
	}
	bodies := map[string]string{"alice": original["alice"], "bob": original["bob"]}
	discoverCrontabOwners = func() ([]string, error) { return []string{"alice", "bob"}, nil }
	readUserCrontab = func(name string) (string, error) { return bodies[name], nil }
	writeUserCrontab = func(name, body string) error {
		if name == "bob" && body == "B\n" {
			return errors.New("write failed")
		}
		bodies[name] = body
		return nil
	}
	t.Cleanup(func() {
		discoverCrontabOwners, readUserCrontab, writeUserCrontab = oldDiscover, oldRead, oldWrite
	})

	if _, err := reconcileManagedUserCrontabs(); err == nil {
		t.Fatal("partial write failure hidden")
	}
	if !reflect.DeepEqual(bodies, original) {
		t.Fatalf("bodies=%q want restored=%q", bodies, original)
	}
}

func TestPrivilegedRemoveRestoresUsersWhenSystemCleanupFails(t *testing.T) {
	oldReconcile, oldRemove := reconcileUserSchedules, removeSystemSchedule
	var calls []string
	reconcileUserSchedules = func() (userCrontabRollback, error) {
		calls = append(calls, "reconcile-users")
		return func() error { calls = append(calls, "restore-users"); return nil }, nil
	}
	removeSystemSchedule = func(path string) error {
		calls = append(calls, "remove:"+path)
		if path == legacySystemPaths[0] {
			return errors.New("remove failed")
		}
		return nil
	}
	t.Cleanup(func() {
		reconcileUserSchedules, removeSystemSchedule = oldReconcile, oldRemove
	})

	if err := removeSchedulesLocked(true); err == nil {
		t.Fatal("system cleanup failure hidden")
	}
	want := []string{
		"reconcile-users",
		"remove:" + systemCronPath,
		"remove:" + legacySystemPaths[0],
		"remove:" + legacySystemPaths[1],
		"restore-users",
	}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("calls=%q want=%q", calls, want)
	}
}

func TestSudoInvocationTargetsInstallUsersCrontab(t *testing.T) {
	if got, want := crontabArgsFor(0, "alice", "-l"), []string{"-u", "alice", "-l"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("args=%q want=%q", got, want)
	}
	if got, want := crontabArgsFor(0, "alice", "-"), []string{"-u", "alice", "-"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("args=%q want=%q", got, want)
	}
	if got, want := crontabArgsFor(1000, "alice", "-l"), []string{"-l"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("non-root args=%q want=%q", got, want)
	}
	if name, got := crontabCommandSpecFor(0, "chris", "-l"); name != "crontab" || !reflect.DeepEqual(got, []string{"-u", "chris", "-l"}) {
		t.Fatalf("root cross-user command=%q %q", name, got)
	}
	if name, got := crontabCommandSpecFor(1000, "chris", "-"); name != "sudo" || !reflect.DeepEqual(got, []string{"-n", "crontab", "-u", "chris", "-"}) {
		t.Fatalf("sudo cross-user command=%q %q", name, got)
	}
}
