package authreconcile

import (
	"context"
	"encoding/json"
	co "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestIndependentReadbackRejectsTruncatedOversizeEnvelope(t *testing.T) {
	_, _, head := fixture(t, "codex")
	raw, _ := json.Marshal(head)
	body := string(raw) + strings.Repeat(" ", (1<<20)-len(raw)) + `{"untrusted_second_envelope":true}`
	var calls atomic.Int32
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_, _ = w.Write([]byte(body))
	}))
	defer s.Close()
	c, e := co.New(co.Options{BaseURL: s.URL, APIKey: "fixture"})
	if e != nil {
		t.Fatal(e)
	}
	got, e := readback(context.Background(), c, "codex", 7, "")
	if e == nil {
		t.Fatalf("oversized malformed readback accepted after truncated prefix: verification=%s account=%d", got.Verification, got.AccountID)
	}
	if calls.Load() != 1 || strings.Contains(e.Error(), "fixture-secret") || strings.Contains(e.Error(), "untrusted_second_envelope") {
		t.Fatal("readback retried or exposed response material")
	}
}
