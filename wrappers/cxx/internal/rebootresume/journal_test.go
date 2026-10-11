package rebootresume

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

const oldBoot = "11111111-1111-4111-8111-111111111111"
const newBoot = "22222222-2222-4222-8222-222222222222"

func fixture(t *testing.T) (Journal, *Record) {
	t.Helper()
	d := t.TempDir()
	j := Journal{Dir: filepath.Join(d, "state"), Cron: filepath.Join(d, "cron")}
	if err := os.Mkdir(j.Dir, 0700); err != nil {
		t.Fatal(err)
	}
	return j, &Record{ID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", Engine: "codex", NativeID: oldBoot, SessionID: newBoot, Address: "agent:" + newBoot, BootID: oldBoot, Reason: "kernel", Continuation: "verify boot then finish", Home: "/home/test", Cwd: "/srv/a space's repo", Executable: "/usr/local/libexec/cxx-reboot-resume/cxx"}
}
func TestAtMostOnceAndSameBoot(t *testing.T) {
	j, r := fixture(t)
	if err := j.Stage(r); err != nil {
		t.Fatal(err)
	}
	r.State = "armed"
	if err := j.Save(r); err != nil {
		t.Fatal(err)
	}
	got, err := j.Consume(r.ID, oldBoot)
	if err != nil || got != nil {
		t.Fatalf("same boot: %v %v", got, err)
	}
	got, err = j.Consume(r.ID, newBoot)
	if err != nil || got == nil || got.State != "consumed" {
		t.Fatalf("new boot: %v %v", got, err)
	}
	if _, err = os.Stat(j.Cron); !os.IsNotExist(err) {
		t.Fatalf("cron retained: %v", err)
	}
	got, err = j.Consume(r.ID, newBoot)
	if err != nil || got != nil {
		t.Fatalf("duplicate: %v %v", got, err)
	}
	r.ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	if err = j.Stage(r); err == nil {
		t.Fatal("rearmed consumed native session")
	}
}
func TestUnlinkFailureCannotRepeat(t *testing.T) {
	j, r := fixture(t)
	if err := j.Stage(r); err != nil {
		t.Fatal(err)
	}
	r.State = "armed"
	if err := j.Save(r); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(j.Cron, []byte("foreign"), 0644); err != nil {
		t.Fatal(err)
	}
	got, err := j.Consume(r.ID, newBoot)
	if err == nil || got != nil {
		t.Fatal("must stop on foreign cron")
	}
	saved, err := j.Read(r.ID)
	if err != nil || saved.State != "consumed" {
		t.Fatal("consume was not durable")
	}
	got, err = j.Consume(r.ID, newBoot)
	if got != nil {
		t.Fatal("retried after unlink failure")
	}
	b, _ := os.ReadFile(j.Cron)
	if string(b) != "foreign" {
		t.Fatal("removed foreign cron")
	}
}
func TestHostSlotAndIdempotency(t *testing.T) {
	j, r := fixture(t)
	copy := *r
	if err := j.Stage(r); err != nil {
		t.Fatal(err)
	}
	if err := j.Stage(&copy); err != nil {
		t.Fatal(err)
	}
	copy.Reason = "changed"
	if err := j.Stage(&copy); err == nil {
		t.Fatal("changed body accepted")
	}
	copy.ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	if err := j.Stage(&copy); err == nil {
		t.Fatal("second host slot accepted")
	}
	a, err := j.Lock()
	if err != nil {
		t.Fatal(err)
	}
	defer a.Release()
	b, err := j.Lock()
	if err == nil {
		b.Release()
		t.Fatal("concurrent owner accepted")
	}
}
func TestExpiredJobNeverLaunches(t *testing.T) {
	j, r := fixture(t)
	if err := j.Stage(r); err != nil {
		t.Fatal(err)
	}
	r.State = "armed"
	r.CreatedAt = time.Now().Add(-25 * time.Hour)
	if err := j.Save(r); err != nil {
		t.Fatal(err)
	}
	got, err := j.Consume(r.ID, newBoot)
	if err == nil || got != nil {
		t.Fatal("expired job consumed")
	}
}
func TestPreparedCannotLaunchAndPathsCannotInjectCron(t *testing.T) {
	j, r := fixture(t)
	if err := j.Stage(r); err != nil {
		t.Fatal(err)
	}
	got, err := j.Consume(r.ID, newBoot)
	if err != nil || got != nil {
		t.Fatal("unarmed job launched")
	}
	r.Executable = "/bin/cxx\n* * * * * root bad"
	if err := r.Validate(); err == nil {
		t.Fatal("cron injection accepted")
	}
}
