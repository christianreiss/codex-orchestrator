package operatorerror

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
)

type Diagnostic interface {
	error
	Diagnostic() (string, []string)
}

// Summary is for compact status rows. Use Describe to show the recovery steps.
func Summary(err error, alias string) string {
	if err == nil {
		return ""
	}
	if reason, _ := Describe(err, alias); reason != "" {
		return reason
	}
	return err.Error()
}

// HTTPResponse represents an orchestrator HTTP failure. The response body
// remains available to protocol callers. Diagnostics only render known codes.
type HTTPResponse struct {
	Status int
	Code   string
	Scope  string
	Body   string
}

func (e HTTPResponse) OperatorHTTPResponse() HTTPResponse { return e }

func (e HTTPResponse) Error() string {
	return fmt.Sprintf("HTTP %d: %s", e.Status, e.Body)
}

// ParseHTTPResponse accepts both the standard and the nested API envelopes.
func ParseHTTPResponse(status int, body []byte) HTTPResponse {
	var response struct {
		Code  string `json:"code"`
		Scope string `json:"scope"`
		Error struct {
			Code  string `json:"code"`
			Scope string `json:"scope"`
		} `json:"error"`
	}
	_ = json.Unmarshal(body, &response)
	if response.Code == "" {
		response.Code, response.Scope = response.Error.Code, response.Error.Scope
	}
	return HTTPResponse{Status: status, Code: response.Code, Scope: response.Scope, Body: strings.TrimSpace(string(body))}
}

// ConnectionCause is safe to send as a local protocol discriminator. It
// never includes a URL, socket path, header, response body or raw error.
func ConnectionCause(err error) string {
	if _, ok := errors.AsType[x509.UnknownAuthorityError](err); ok {
		return "tls_unknown_authority"
	}
	if _, ok := errors.AsType[x509.HostnameError](err); ok {
		return "tls_hostname_mismatch"
	}
	if cert, ok := errors.AsType[x509.CertificateInvalidError](err); ok {
		if cert.Reason == x509.Expired {
			return "tls_certificate_time"
		}
		return "tls_certificate_invalid"
	}
	if _, ok := errors.AsType[*net.DNSError](err); ok {
		return "dns_lookup_failed"
	}
	if op, ok := errors.AsType[*net.OpError](err); ok && strings.HasPrefix(op.Net, "unix") {
		return "local_connection_failed"
	}
	if errors.Is(err, syscall.ECONNREFUSED) {
		return "connection_refused"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "timeout"
	}
	if op, ok := errors.AsType[*net.OpError](err); ok {
		if op.Timeout() {
			return "timeout"
		}
		return "connection_failed"
	}
	return ""
}

// Describe returns a concise reason and a next action for known failures.
// An empty reason lets callers retain the context of an unmatched local error.
func Describe(err error, alias string) (string, []string) {
	if err == nil {
		return "", nil
	}
	doctor := "Run `" + alias + " doctor` to check the connection."
	if alias == "cxx" {
		doctor = "Run the affected wrapper's doctor, for example `cdx doctor`."
	}
	if cause := ConnectionCause(err); cause != "" {
		summary, steps := connectionAdvice(cause, doctor)
		if req, ok := errors.AsType[*url.Error](err); ok {
			if target, parseErr := url.Parse(req.URL); parseErr == nil && target.Hostname() != "" {
				steps = append([]string{"Server: " + target.Hostname()}, steps...)
			}
		}
		return summary, steps
	}
	if d, ok := errors.AsType[Diagnostic](err); ok {
		return d.Diagnostic()
	}
	if failure, ok := errors.AsType[interface {
		error
		OperatorHTTPResponse() HTTPResponse
	}](err); ok {
		if response := failure.OperatorHTTPResponse(); response.Status >= 400 {
			return describeHTTP(response, doctor)
		}
	}
	if response, ok := legacyHTTPFailure(err.Error()); ok {
		return describeHTTP(response, doctor)
	}
	switch {
	case errors.Is(err, context.Canceled):
		return "Operation cancelled", nil
	case errors.Is(err, syscall.ENOSPC), errors.Is(err, syscall.EDQUOT):
		return "The filesystem has run out of space or quota", []string{"Check available disk space and inodes, free space and retry."}
	case errors.Is(err, fs.ErrPermission):
		return "Permission denied", localAdvice(err, "Check the file or directory ownership and run the command as the user who installed this wrapper.")
	case errors.Is(err, exec.ErrNotFound):
		return "The required program is missing", []string{"Check which executable is missing with the wrapper's doctor. Run `cxx update` to install the configured engine."}
	case errors.Is(err, fs.ErrNotExist):
		return "A required file is missing", localAdvice(err, "Check the path and restore the file through the original installation or configuration.")
	default:
		return "", nil
	}
}

// Existing Communicator workers also serialize resource errors as strings.
// Recognize only their METHOD path -> STATUS: body format; the UI never echoes
// an HTTP response body even if the originating worker predates typed diagnostics.
func legacyHTTPFailure(message string) (HTTPResponse, bool) {
	head, tail, ok := strings.Cut(message, " -> ")
	if !ok || !strings.Contains(head, " /") {
		return HTTPResponse{}, false
	}
	rawStatus, body, ok := strings.Cut(tail, ": ")
	status, err := strconv.Atoi(rawStatus)
	if !ok || err != nil || status < 400 || status > 599 {
		return HTTPResponse{}, false
	}
	return ParseHTTPResponse(status, []byte(body)), true
}

func localAdvice(err error, advice string) []string {
	if path, ok := errors.AsType[*fs.PathError](err); ok {
		return []string{"Path: " + path.Path, advice}
	}
	return []string{advice}
}

func connectionAdvice(cause, doctor string) (string, []string) {
	switch cause {
	case "tls_unknown_authority":
		return "TLS certificate is not trusted on this host", []string{
			"Install the Orchestrator's verified root CA in this host's trust store, or have the administrator correct the certificate chain, then retry.",
			doctor,
		}
	case "tls_hostname_mismatch":
		return "The TLS certificate does not match the server address", []string{"Check the configured Orchestrator address and ask the administrator to verify its certificate.", doctor}
	case "tls_certificate_time":
		return "The TLS certificate is expired or not valid yet", []string{"Check this host's date and time. If the clock is correct, ask the administrator to renew or replace the server certificate.", doctor}
	case "tls_certificate_invalid":
		return "The server sent an invalid TLS certificate", []string{"Ask the administrator to check the Orchestrator certificate and its chain.", doctor}
	case "dns_lookup_failed":
		return "Could not resolve the Orchestrator address", []string{"Check the configured server name and this host's DNS settings.", doctor}
	case "local_connection_failed":
		return "The local Communicator could not be reached", []string{"Run `cxx communicator status` to check the local service.", doctor}
	case "connection_refused", "connection_failed":
		return "Could not connect to the Orchestrator", []string{"Check the server address, network connection and whether the service is reachable.", doctor}
	case "timeout":
		return "The operation timed out", []string{"Check server availability and the network connection before trying again.", doctor}
	default:
		return "", nil
	}
}

func describeHTTP(response HTTPResponse, doctor string) (string, []string) {
	switch response.Code {
	case "communicator_unavailable", "communicator_outcome_unknown":
		var payload struct {
			Error struct {
				Cause   string `json:"cause"`
				Message string `json:"message"`
			} `json:"error"`
			Message string `json:"message"`
		}
		_ = json.Unmarshal([]byte(response.Body), &payload)
		const verifyResult = "If the request changed data, verify its result before repeating it."
		if summary, details := connectionAdvice(payload.Error.Cause, doctor); summary != "" {
			if response.Code == "communicator_outcome_unknown" && !strings.HasPrefix(payload.Error.Cause, "tls_") &&
				payload.Error.Cause != "dns_lookup_failed" && payload.Error.Cause != "connection_refused" {
				details = append(details, verifyResult)
			}
			return summary, details
		}
		if payload.Error.Cause == "cache_confirmation_missing" {
			return "The Communicator could not verify the launch configuration", []string{
				"Run `cxx communicator status` to check the running version. Run `cxx update` if the wrapper is outdated.",
			}
		}
		// Older owners provide TLS errors as plain text in their 503s. Only
		// recognize the fixed certificate phrases, never render that text.
		if response.Code == "communicator_unavailable" {
			message := payload.Error.Message + payload.Message
			switch {
			case strings.Contains(message, "x509: certificate signed by unknown authority"):
				return connectionAdvice("tls_unknown_authority", doctor)
			case strings.Contains(message, "x509: certificate has expired or is not yet valid"):
				return connectionAdvice("tls_certificate_time", doctor)
			}
			if _, verdict, ok := strings.Cut(message, "communicator handshake rejected: HTTP "); ok {
				fields := strings.Fields(verdict)
				if len(fields) >= 2 {
					switch fields[1] {
					case "api_disabled", "communicator_disabled", "invalid_api_key", "missing_api_key",
						"ip_mismatch", "reverse_dns_failed", "host_expired", "host_suspended", "host_revoked":
						return describeHTTP(HTTPResponse{Code: fields[1]}, doctor)
					}
				}
			}
			return "The Communicator could not reach the Orchestrator", []string{"Run `cxx communicator status` to check the connection.", doctor}
		}
		return "The Communicator did not receive a confirmation", []string{
			"Run `cxx communicator status` to check the connection.",
			verifyResult,
			doctor,
		}
	case "insecure_pending":
		return "This host needs approval", []string{"Approve the pending request in the Orchestrator under Hosts, then retry."}
	case "insecure_denied":
		return "Approval for this host was denied", []string{"Ask the administrator to review the request in the Orchestrator under Hosts."}
	case "ip_mismatch", "reverse_dns_failed":
		return "The Orchestrator could not verify this host's network identity", []string{"Check the host's current IP and DNS against its registration in the Orchestrator."}
	case "host_expired", "host_inactive", "host_suspended", "host_revoked":
		return "This host registration is no longer active", []string{"Ask the administrator to review the host's registration in the Orchestrator."}
	case "invalid_api_key", "missing_api_key":
		return "The Orchestrator rejected this host's credentials", []string{"Check that this host is registered and use a current installer for this host to renew its credentials."}
	case "engine_disabled":
		if response.Scope == "fleet" {
			return "This engine is disabled fleet-wide", []string{"Choose an enabled engine or ask the fleet administrator to re-enable it."}
		}
		return "This engine is unavailable for this host", []string{"Check the engine assignment and fleet engine setting in the Orchestrator."}
	case "api_disabled":
		return "The Orchestrator API is disabled", []string{"Ask the administrator to check the API setting before retrying."}
	case "communicator_disabled":
		return "The Communicator is disabled in the Orchestrator", []string{"Ask the administrator to check the Communicator setting before retrying."}
	case "runner_unavailable", "runner_unreachable":
		return "The Orchestrator could not reach the authentication runner", []string{"Ask the administrator to check the runner before attempting login again."}
	case "account_unavailable", "canonical_auth_missing":
		return "No verified subscription account is available for this engine", []string{"Ask the administrator to check the engine's accounts and authentication status in the Orchestrator."}
	case "quota_emulation_limit":
		return "The configured usage limit has been reached", []string{"Check the usage reset time and wait for the next window before retrying."}
	}
	switch response.Status {
	case http.StatusBadRequest:
		return "The Orchestrator rejected the request as invalid (HTTP 400)", []string{"Check the command arguments and whether this wrapper is current.", doctor}
	case http.StatusUnauthorized, http.StatusForbidden:
		return fmt.Sprintf("The Orchestrator refused access (HTTP %d)", response.Status), []string{doctor}
	case http.StatusTooManyRequests:
		return "The Orchestrator is rate limiting requests", []string{"Wait before retrying this operation."}
	case http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout:
		return fmt.Sprintf("The Orchestrator is temporarily unavailable (HTTP %d)", response.Status), []string{doctor}
	default:
		return fmt.Sprintf("The Orchestrator request failed (HTTP %d)", response.Status), []string{doctor}
	}
}
