package update

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
)

func VerifyChecksum(path, expectedHex string) error {
	if len(expectedHex) != 64 {
		return errors.New("expected sha256 must be 64 hex chars")
	}
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return err
	}
	got := hex.EncodeToString(h.Sum(nil))
	// Case-insensitive: a server-emitted uppercase digest is still a correct
	// match (consistent with the cron and peer sha256 checks).
	if !strings.EqualFold(got, expectedHex) {
		return fmt.Errorf("sha256 mismatch: got %s want %s", got, expectedHex)
	}
	return nil
}
