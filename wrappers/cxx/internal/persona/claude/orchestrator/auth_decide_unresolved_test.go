package orchestrator

import (
	"strings"
	"testing"
	"time"
)

// A communicator pending-auth marker means an earlier credential upload has no
// confirmed outcome. The launch is refused on purpose (nothing may be replayed or
// overwritten blindly), but the operator must be told why and how to resolve it,
// and even a fresh cached credential must not turn it into an "offline" launch.
func TestDecideNamesAnUnresolvedUpload(t *testing.T) {
	fresh := LocalAuthProbe{
		IsValid: func(string) bool { return true },
		IsFresh: func(string, time.Duration) (bool, error) { return true, nil },
	}
	got := Decide(&AuthRetrieveResponse{Status: "offline", Message: UnresolvedUploadMessage}, "/dev/null", true, fresh)
	if got.Allowed {
		t.Fatalf("an unresolved upload must refuse the launch, got reason %q", got.Reason)
	}
	for _, want := range []string{"upload", "no confirmed outcome", "pending-auth", "clx login", "clx auth-reconcile", "--accept-server", "explicitly", "intended one"} {
		if !strings.Contains(strings.ToLower(got.Reason), want) {
			t.Fatalf("reason %q lacks %q", got.Reason, want)
		}
	}
	// Inspecting a digest or a timestamp is never an instruction to delete the marker, and
	// there is no shortcut that clears it on the operator's behalf.
	lower := strings.ToLower(got.Reason)
	for _, banned := range []string{"then delete the marker", "compare this host", "force", "--clear"} {
		if strings.Contains(lower, banned) {
			t.Fatalf("reason %q must not suggest %q", got.Reason, banned)
		}
	}
	if strings.Contains(got.Reason, "Auth unavailable") {
		t.Fatalf("the generic message hides the cause: %q", got.Reason)
	}
}

func TestIsUnresolvedUploadRecognizesBothVerdicts(t *testing.T) {
	for _, message := range []string{UnresolvedUploadMessage, "Previous auth upload outcome remains unknown; local credentials retained"} {
		if !IsUnresolvedUpload(message) {
			t.Fatalf("not recognized: %q", message)
		}
	}
	if IsUnresolvedUpload("dial tcp: connection refused") {
		t.Fatal("an ordinary outage must keep the offline fallback")
	}
}
