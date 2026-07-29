package update

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeVerifyFixture writes body to a temp file and returns its path and the
// lowercase hex SHA256 of the contents.
func writeVerifyFixture(t *testing.T, body string) (string, string) {
	t.Helper()
	p := filepath.Join(t.TempDir(), "binary")
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(body))
	return p, hex.EncodeToString(sum[:])
}

func TestVerifyChecksumAcceptsLowercaseDigest(t *testing.T) {
	p, digest := writeVerifyFixture(t, "wrapper-binary-payload")
	if err := VerifyChecksum(p, digest); err != nil {
		t.Fatalf("lowercase digest should match: %v", err)
	}
}

func TestVerifyChecksumAcceptsUppercaseDigest(t *testing.T) {
	p, digest := writeVerifyFixture(t, "wrapper-binary-payload")
	if err := VerifyChecksum(p, strings.ToUpper(digest)); err != nil {
		t.Fatalf("uppercase digest should match: %v", err)
	}
}

func TestVerifyChecksumRejectsMismatchedDigest(t *testing.T) {
	p, digest := writeVerifyFixture(t, "wrapper-binary-payload")
	other := sha256.Sum256([]byte("tampered-payload"))
	err := VerifyChecksum(p, hex.EncodeToString(other[:]))
	if err == nil {
		t.Fatal("mismatched digest must be rejected")
	}
	if !strings.Contains(err.Error(), digest) {
		t.Fatalf("error = %q, want the computed digest reported", err.Error())
	}
}

func TestVerifyChecksumRejectsWrongLengthExpectation(t *testing.T) {
	p, digest := writeVerifyFixture(t, "wrapper-binary-payload")
	// A truncated prefix of the correct digest must fail the length
	// precondition rather than be compared against the file.
	for _, expected := range []string{"", digest[:63], digest + "0"} {
		err := VerifyChecksum(p, expected)
		if err == nil {
			t.Fatalf("expected %q (len %d) must be rejected", expected, len(expected))
		}
		if !strings.Contains(err.Error(), "64 hex chars") {
			t.Fatalf("error for len %d = %q, want length precondition", len(expected), err.Error())
		}
	}
}

func TestVerifyChecksumRejectsMissingFile(t *testing.T) {
	_, digest := writeVerifyFixture(t, "wrapper-binary-payload")
	missing := filepath.Join(t.TempDir(), "does-not-exist")
	err := VerifyChecksum(missing, digest)
	if err == nil {
		t.Fatal("nonexistent path must be rejected")
	}
	if !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("error = %v, want os.ErrNotExist", err)
	}
}
