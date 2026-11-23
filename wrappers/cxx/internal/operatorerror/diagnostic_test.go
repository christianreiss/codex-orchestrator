package operatorerror

import (
	"context"
	"crypto/x509"
	"fmt"
	"net"
	"net/url"
	"strings"
	"syscall"
	"testing"
)

func TestOperatorDiagnostics(t *testing.T) {
	for _, test := range []struct {
		name, reason, action string
		err                  error
	}{
		{"unknown CA", "not trusted", "verified root CA", &url.Error{Op: "Get", URL: "https://api.example.test/?secret=token", Err: x509.UnknownAuthorityError{}}},
		{"expired certificate", "expired or not valid yet", "date and time", x509.CertificateInvalidError{Reason: x509.Expired}},
		{"DNS", "resolve", "DNS settings", &net.DNSError{Name: "api.example.test", IsNotFound: true}},
		{"timeout", "timed out", "server availability", context.DeadlineExceeded},
		{"disk full", "run out of space", "inodes", syscall.ENOSPC},
		{"approval", "needs approval", "Approve the pending request", HTTPResponse{Status: 423, Code: "insecure_pending", Body: "secret"}},
		{"approval denied", "was denied", "review the request", HTTPResponse{Status: 403, Code: "insecure_denied", Body: "secret"}},
		{"host IP", "network identity", "IP and DNS", HTTPResponse{Status: 401, Code: "ip_mismatch", Body: "secret"}},
		{"disabled engine", "disabled fleet-wide", "Choose an enabled engine", HTTPResponse{Status: 403, Code: "engine_disabled", Scope: "fleet"}},
		{"runner", "authentication runner", "check the runner", HTTPResponse{Status: 503, Code: "runner_unavailable"}},
		{"account", "No verified subscription account", "check the engine's accounts", HTTPResponse{Status: 503, Code: "account_unavailable"}},
		{"rate limit", "rate limiting", "Wait before retrying", HTTPResponse{Status: 429}},
		{"unknown outcome", "did not receive a confirmation", "verify its result", HTTPResponse{Status: 409, Code: "communicator_outcome_unknown"}},
		{"unconfirmed timeout", "timed out", "verify its result", ParseHTTPResponse(409, []byte(`{"error":{"code":"communicator_outcome_unknown","cause":"timeout"}}`))},
		{"legacy TLS", "not trusted", "root CA", ParseHTTPResponse(503, []byte(`{"error":{"code":"communicator_unavailable","message":"x509: certificate signed by unknown authority"}}`))},
		{"legacy server refusal", "Orchestrator API is disabled", "check the API setting", ParseHTTPResponse(503, []byte(`{"error":{"code":"communicator_unavailable","message":"communicator_unavailable: communicator handshake rejected: HTTP 403 api_disabled (secret)"}}`))},
	} {
		t.Run(test.name, func(t *testing.T) {
			reason, steps := Describe(fmt.Errorf("wrapper operation: %w", test.err), "clx")
			advice := strings.Join(steps, " ")
			if !strings.Contains(reason, test.reason) || !strings.Contains(advice, test.action) || strings.Contains(reason+advice, "secret") {
				t.Fatalf("reason=%q advice=%q", reason, advice)
			}
		})
	}
}
