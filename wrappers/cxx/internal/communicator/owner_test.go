package communicator

import (
	"bytes"
	"context"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func ownerSocket(t *testing.T, dir, name string, handler http.HandlerFunc) string {
	t.Helper()
	socket := filepath.Join(dir, name)
	ln, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: handler}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close() })
	return socket
}

func statusBody(body string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/_comm/status" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(body))
	}
}

// A transfer preflight reads the owner that is already running and never
// starts one; anything it cannot read reports ok=false so callers proceed.
func TestOwnerStatusReadsOnlyARunningOwner(t *testing.T) {
	dir, err := os.MkdirTemp("", "cxo")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	old := ownerSocket(t, dir, "old.sock", statusBody(`{"protocol":1,"version":"0.9.83","pid":4242,"mode":"resident","connected":true}`))
	text := ownerSocket(t, dir, "text.sock", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("not json")) })
	cases := []struct {
		base string
		ep   *endpoint
		ok   bool
	}{
		{"https://owner-old.example", &endpoint{base: "https://owner-old.example", socket: old}, true},
		{"https://owner-text.example", &endpoint{base: "https://owner-text.example", socket: text}, false},
		{"https://owner-missing.example", &endpoint{base: "https://owner-missing.example", socket: filepath.Join(dir, "missing.sock")}, false},
		{"https://owner-runtime-only.example", &endpoint{base: "https://owner-runtime-only.example", socket: old, runtimeOnly: true}, false},
		{"https://owner-setup.example", &endpoint{base: "https://owner-setup.example", socket: old, setupErr: os.ErrPermission}, false},
	}
	for _, c := range cases {
		registry.Store(c.base, c.ep)
		base := c.base
		t.Cleanup(func() { registry.Delete(base) })
	}
	for _, c := range cases {
		owner, ok := OwnerStatus(context.Background(), c.base+"/")
		if ok != c.ok {
			t.Fatalf("%s: ok=%v owner=%+v", c.base, ok, owner)
		}
		if ok && (owner.Version != "0.9.83" || owner.PID != 4242 || owner.Mode != "resident") {
			t.Fatalf("%s: owner %+v", c.base, owner)
		}
	}
	if _, ok := OwnerStatus(context.Background(), "https://unconfigured.example"); ok {
		t.Fatal("direct HTTPS base reported an owner")
	}
	if _, err := os.Stat(filepath.Join(dir, "missing.sock")); !os.IsNotExist(err) {
		t.Fatal("status read started an owner")
	}
}

func TestOlderThan(t *testing.T) {
	for _, c := range []struct {
		version, minimum string
		want             bool
	}{
		{"0.9.83", "0.9.93", true},
		{"v0.9.92", "0.9.93", true},
		{"0.9.93", "0.9.93", false},
		{"0.9.100", "0.9.93", false},
		{"1.0.0", "0.9.93", false},
		{"dev", "0.9.93", false},
		{"0.9.83", "test", false},
		{"", "0.9.93", false},
	} {
		if got := OlderThan(c.version, c.minimum); got != c.want {
			t.Fatalf("OlderThan(%q, %q) = %v", c.version, c.minimum, got)
		}
	}
}

// doctor names an owner older than the cxx running it, with the supported
// replacement step, without failing on that alone.
func TestDoctorWarnsAboutStaleOwner(t *testing.T) {
	dir, err := os.MkdirTemp("", "cxd")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	// Only the stubs: this host's own signed endpoints must not decide the verdict.
	saved := map[any]any{}
	registry.Range(func(k, v any) bool { saved[k] = v; registry.Delete(k); return true })
	t.Cleanup(func() {
		for k, v := range saved {
			registry.Store(k, v)
		}
	})
	resident := ownerSocket(t, dir, "res.sock", statusBody(`{"server":"https://stale-resident.example","version":"0.9.83","pid":4242,"mode":"resident","connected":true}`))
	onDemand := ownerSocket(t, dir, "dem.sock", statusBody(`{"server":"https://stale-ondemand.example","version":"0.9.83","pid":77,"mode":"on_demand","connected":true}`))
	for base, socket := range map[string]string{"https://stale-resident.example": resident, "https://stale-ondemand.example": onDemand} {
		registry.Store(base, &endpoint{base: base, socket: socket})
		b := base
		t.Cleanup(func() { registry.Delete(b) })
	}
	var out bytes.Buffer
	if failed := statusReport(&out, "0.9.100"); failed {
		t.Fatalf("stale owner alone failed doctor: %s", out.String())
	}
	for base, want := range map[string]string{"https://stale-resident.example": "sudo cxx daemon install", "https://stale-ondemand.example": "kill 77"} {
		line := statusLineFor(t, out.String(), base)
		stale, _ := line["stale_owner"].(map[string]any)
		remedy, _ := stale["remedy"].(string)
		if stale["current_version"] != "0.9.100" || !strings.Contains(remedy, want) {
			t.Fatalf("%s: stale_owner %v, want remedy containing %q", base, line["stale_owner"], want)
		}
	}
	out.Reset()
	statusReport(&out, "dev")
	if strings.Contains(out.String(), "stale_owner") {
		t.Fatalf("unversioned build flagged an owner: %s", out.String())
	}
}
