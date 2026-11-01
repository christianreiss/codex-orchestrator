package lifecycle

import (
	orchestrator "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
	"strings"
	"testing"
)

func TestBootstrapValidationDoesNotAllowCachedCredentials(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	err := &orchestrator.HTTPError{StatusCode: 422, Method: "POST", Path: "/sync/bootstrap", Body: "model requires CLI 0.163.0 or newer; observed unreported"}
	dec := decideAuth(&orchestrator.AuthRetrieveResponse{Status: "valid"}, err, "", true)
	if dec.Allowed || dec.LocalUsable || !strings.Contains(dec.Reason, "observed unreported") {
		t.Fatalf("decision=%+v", dec)
	}
}
