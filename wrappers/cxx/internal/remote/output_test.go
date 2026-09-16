package remote

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

// TestPutStreamKeepsInvalidUTF8Exact pins the one silent-corruption path in the
// whole package. encoding/json rewrites invalid UTF-8 in a Go string to U+FFFD
// and reports nothing, so a command emitting latin-1, a tarball, or a multi-byte
// sequence cut in half by a read boundary would come back wrong with a
// successful status beside it.
func TestPutStreamKeepsInvalidUTF8Exact(t *testing.T) {
	// "ä" is 0xC3 0xA4; a chunk boundary that lands between them leaves a lone
	// continuation byte, which is exactly what a cursored read produces.
	payload := []byte{0xC3}
	got := map[string]any{}
	putStream(got, "stdout", payload)

	if _, present := got["stdout"]; present {
		t.Fatalf("invalid UTF-8 was placed in the text field: %#v", got)
	}
	if got["binary"] != true {
		t.Fatalf("binary flag = %v, want true", got["binary"])
	}
	encoded, ok := got["stdout_b64"].(string)
	if !ok {
		t.Fatalf("stdout_b64 missing: %#v", got)
	}
	decoded, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || !bytes.Equal(decoded, payload) {
		t.Fatalf("round trip = %#v (%v), want %#v", decoded, err, payload)
	}
}

func TestPutStreamKeepsTextAsText(t *testing.T) {
	got := map[string]any{}
	putStream(got, "stdout", []byte("make: Entering directory 'äöü'\n"))
	if got["stdout"] != "make: Entering directory 'äöü'\n" {
		t.Fatalf("stdout = %#v", got["stdout"])
	}
	if _, present := got["binary"]; present {
		t.Fatalf("binary flag set for valid UTF-8: %#v", got)
	}
}

func TestPutStreamTreatsEmptyOutputAsText(t *testing.T) {
	got := map[string]any{}
	putStream(got, "stderr", nil)
	if got["stderr"] != "" {
		t.Fatalf("stderr = %#v, want the empty string", got["stderr"])
	}
	if _, present := got["stderr_b64"]; present {
		t.Fatalf("empty output was base64 encoded: %#v", got)
	}
}

// TestUnknownIsNeverReportedAsFailure keeps the distinction the whole retry
// story rests on. "We do not know whether it ran" must not reach a caller
// wearing the word failed, because the obvious response to failed is to run it
// again — and running it again is the one thing that is not safe here.
func TestUnknownIsNeverReportedAsFailure(t *testing.T) {
	var out bytes.Buffer
	err := failf(CodeDeliveryUnknown, "the connection dropped after the request was sent").
		with("recheck", "cxx remote ps --host build01 --job build-api")
	if emitErr := emitError(&out, err); emitErr != nil {
		t.Fatalf("emit: %v", emitErr)
	}
	var payload map[string]any
	if decodeErr := json.Unmarshal(out.Bytes(), &payload); decodeErr != nil {
		t.Fatalf("decode %q: %v", out.String(), decodeErr)
	}
	if payload["status"] != "unknown" {
		t.Fatalf("status = %v, want unknown", payload["status"])
	}
	if strings.Contains(strings.ToLower(out.String()), "fail") {
		t.Fatalf("an uncertain outcome used the word fail: %s", out.String())
	}
	if payload["recheck"] != "cxx remote ps --host build01 --job build-api" {
		t.Fatalf("recheck = %v", payload["recheck"])
	}
	if got := exitFor(err); got != ExitUnknown {
		t.Fatalf("exit = %d, want %d", got, ExitUnknown)
	}
}

func TestExitForMapsEverySymbolItPromises(t *testing.T) {
	for _, tc := range []struct {
		code string
		want int
	}{
		{CodeUsage, ExitUsage},
		{CodeDeliveryUnknown, ExitUnknown},
		{CodeTransport, ExitTransport},
		{CodeRemoteAuth, ExitTransport},
		{CodeRemoteSilent, ExitTransport},
		{CodeDenied, ExitError},
		{CodeNotImplemented, ExitError},
	} {
		if got := exitFor(failf(tc.code, "x")); got != tc.want {
			t.Fatalf("exitFor(%s) = %d, want %d", tc.code, got, tc.want)
		}
	}
	if got := exitFor(errors.New("plain")); got != ExitError {
		t.Fatalf("exitFor(plain) = %d, want %d", got, ExitError)
	}
}

// TestEmitJSONLeavesShellPunctuationAlone matters because the payload carries
// commands and paths: HTML-escaped ampersands in a `next` hint would be pasted
// back into a shell verbatim and would not run.
func TestEmitJSONLeavesShellPunctuationAlone(t *testing.T) {
	var out bytes.Buffer
	if err := emitOK(&out, map[string]any{"next": "cxx remote read --job a && echo <done>"}); err != nil {
		t.Fatalf("emit: %v", err)
	}
	if !strings.Contains(out.String(), "&& echo <done>") {
		t.Fatalf("punctuation was escaped: %s", out.String())
	}
	if lines := strings.Count(strings.TrimRight(out.String(), "\n"), "\n"); lines != 0 {
		t.Fatalf("response is not a single line: %q", out.String())
	}
}

// asError keeps the test files free of an errors import each.
func asError(err error, target **Error) bool {
	return errors.As(err, target)
}
