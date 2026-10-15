package orchestrator

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/accountpool"
)

func TestAuthAfterAssignmentReusesOnlySameVerifiedHead(t *testing.T) {
	for _, scenario := range []struct {
		name   string
		change func(*AuthRetrieveResponse, *accountpool.LeaseResponse)
	}{
		{"same_verified_head", nil},
		{"account_switch", func(a *AuthRetrieveResponse, l *accountpool.LeaseResponse) { l.AccountID++ }},
		{"canonical_rotation", func(a *AuthRetrieveResponse, l *accountpool.LeaseResponse) {
			l.CanonicalDigest = strings.Repeat("b", 64)
		}},
		{"missing_digest", func(a *AuthRetrieveResponse, l *accountpool.LeaseResponse) { a.CanonicalDigest = "" }},
		{"unverified_snapshot", func(a *AuthRetrieveResponse, l *accountpool.LeaseResponse) { a.VerificationState = "failed" }},
		{"unverified_lease", func(a *AuthRetrieveResponse, l *accountpool.LeaseResponse) { l.VerificationState = "unknown" }},
		{"outdated_snapshot", func(a *AuthRetrieveResponse, l *accountpool.LeaseResponse) { a.Status = "outdated" }},
		{"legacy_snapshot", func(a *AuthRetrieveResponse, l *accountpool.LeaseResponse) { a.AccountPool = false }},
		{"missing_host", func(a *AuthRetrieveResponse, l *accountpool.LeaseResponse) { a.Host = nil }},
		{"missing_versions", func(a *AuthRetrieveResponse, l *accountpool.LeaseResponse) { a.Versions = nil }},
		{"rejected_candidate", func(a *AuthRetrieveResponse, l *accountpool.LeaseResponse) { a.CandidateCredentialRejected = true }},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				// Preserve refusal verdicts when the account or canonical head
				// changed; a previous valid snapshot cannot override them.
				_ = json.NewEncoder(w).Encode(AuthRetrieveResponse{Status: "outdated", VerificationState: "failed"})
			}))
			defer server.Close()
			client, err := New(Options{BaseURL: server.URL})
			if err != nil {
				t.Fatal(err)
			}
			oldLimit, newLimit, newPartition, hardFail := 95, 80, 0, false
			previous := &AuthRetrieveResponse{Status: "valid", AccountPool: true, AccountID: 2, CanonicalDigest: strings.Repeat("a", 64), VerificationState: "verified", Host: &HostInfo{Secure: true}, Versions: &VersionSummary{}, QuotaHardFail: true, QuotaLimitPercent: &oldLimit}
			lease := &accountpool.LeaseResponse{AccountID: 2, CanonicalDigest: previous.CanonicalDigest, VerificationState: "verified", QuotaHardFail: &hardFail, QuotaLimitPercent: &newLimit, QuotaWeekPartition: &newPartition}
			if scenario.change != nil {
				scenario.change(previous, lease)
			}
			got, err := client.AuthAfterAssignment(context.Background(), previous, lease)
			if err != nil {
				t.Fatal(err)
			}
			if scenario.change != nil {
				if calls != 1 || got.VerificationState != "failed" {
					t.Fatalf("changed assignment bypassed retrieve: calls=%d response=%+v", calls, got)
				}
			} else {
				if calls != 0 || got.Status != "valid" || got.AccountID != 2 || got.QuotaHardFail || *got.QuotaLimitPercent != newLimit {
					t.Fatalf("snapshot reuse failed: calls=%d response=%+v", calls, got)
				}
				if !previous.QuotaHardFail || *previous.QuotaLimitPercent != oldLimit {
					t.Fatal("reuse mutated the prior snapshot")
				}
			}
		})
	}
}
