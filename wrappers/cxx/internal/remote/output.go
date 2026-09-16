package remote

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"unicode/utf8"
)

// Exit codes. 255 is deliberately ssh(1)'s own "the transport failed, the
// remote command never reported" signal: callers and models already read it
// that way, and inventing a different number for the same condition would only
// make a remote failure look like an application failure.
const (
	ExitOK        = 0
	ExitError     = 1
	ExitUsage     = 2
	ExitUnknown   = 3
	ExitTransport = 255
)

// Stable error symbols. These are the contract; the human message beside them
// is not. Never derive control flow from the message text.
const (
	CodeNotImplemented  = "E_NOT_IMPLEMENTED"
	CodeUsage           = "E_USAGE"
	CodeDenied          = "E_DENIED"
	CodeIO              = "E_IO"
	CodeNoHome          = "E_NO_HOME"
	CodePathTooLong     = "E_PATH_TOO_LONG"
	CodeJobNotFound     = "E_JOB_NOT_FOUND"
	CodeJobConflict     = "E_JOB_ID_CONFLICT"
	CodeJobLostReboot   = "E_JOB_LOST_REBOOT"
	CodeExecFailed      = "E_EXEC_FAILED"
	CodeTooLarge        = "E_TOO_LARGE"
	CodeState           = "E_STATE"
	CodeNoArtifact      = "E_NO_ARTIFACT"
	CodeInstallFailed   = "E_INSTALL_FAILED"
	CodeRemoteAuth      = "E_REMOTE_AUTH"
	CodeRemoteSilent    = "E_REMOTE_NO_RESPONSE"
	CodeTransport       = "E_TRANSPORT"
	CodeDeliveryUnknown = "E_DELIVERY_UNKNOWN"
)

// Error carries a stable symbol and optional structured fields into the single
// JSON object a `cxx remote` invocation prints. Fields never carry payload
// bytes, env values, or a full argv; see the package doc.
type Error struct {
	Code    string
	Message string
	Fields  map[string]any
	Wrapped error
}

func (e *Error) Error() string { return e.Message }

func (e *Error) Unwrap() error { return e.Wrapped }

func failf(code, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

func (e *Error) with(key string, value any) *Error {
	if e.Fields == nil {
		e.Fields = map[string]any{}
	}
	e.Fields[key] = value
	return e
}

// exitFor maps an error to the process exit code. An uncertain outcome is its
// own code precisely so that a caller cannot mistake "we do not know whether it
// ran" for "it did not run".
func exitFor(err error) int {
	var typed *Error
	if !errors.As(err, &typed) {
		return ExitError
	}
	switch typed.Code {
	case CodeUsage:
		return ExitUsage
	case CodeDeliveryUnknown:
		return ExitUnknown
	case CodeTransport, CodeRemoteAuth, CodeRemoteSilent:
		return ExitTransport
	default:
		return ExitError
	}
}

// emitJSON writes exactly one JSON object followed by a newline. HTML escaping
// stays off so command output and paths survive the round trip unaltered; the
// same choice as agentbus.writeJSON.
func emitJSON(w io.Writer, payload map[string]any) error {
	encoder := json.NewEncoder(w)
	encoder.SetEscapeHTML(false)
	return encoder.Encode(payload)
}

func emitOK(w io.Writer, fields map[string]any) error {
	payload := map[string]any{"status": "ok"}
	for key, value := range fields {
		payload[key] = value
	}
	return emitJSON(w, payload)
}

func emitError(w io.Writer, err error) error {
	var typed *Error
	if !errors.As(err, &typed) {
		typed = &Error{Code: CodeIO, Message: err.Error()}
	}
	status := "error"
	if typed.Code == CodeDeliveryUnknown {
		status = "unknown"
	}
	payload := map[string]any{"status": status, "code": typed.Code, "message": typed.Message}
	for key, value := range typed.Fields {
		payload[key] = value
	}
	return emitJSON(w, payload)
}

// putStream places captured process output into the response under key.
//
// encoding/json replaces invalid UTF-8 in a Go string with U+FFFD and reports
// nothing. A command emitting latin-1, a tarball, or a multi-byte sequence that
// a read boundary cut in half would therefore come back quietly wrong. So: text
// only when the bytes really are text, base64 under "<key>_b64" otherwise, and
// never a repair in between. The "binary" flag is set once for the whole
// response so a caller can branch before looking at either field.
func putStream(payload map[string]any, key string, data []byte) {
	if utf8.Valid(data) {
		payload[key] = string(data)
		return
	}
	payload[key+"_b64"] = base64.StdEncoding.EncodeToString(data)
	payload["binary"] = true
}
