package orchestrator

import (
	"context"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/buildinfo"
	"net/http"
	"testing"
)

func TestCallerReportsRunningWrapperVersion(t *testing.T) {
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("X-Wrapper-Version"); got != buildinfo.Version {
			t.Errorf("capability version = %q, running build = %q", got, buildinfo.Version)
		}
		w.WriteHeader(http.StatusNoContent)
	})
	request, err := http.NewRequestWithContext(context.Background(), "POST", client.BaseURL+"/sync/bootstrap", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("X-Wrapper-Version", "99.0.0")
	response, err := client.Do(context.Background(), request, 0)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
}
