package claude

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
)

func TestEnsureClaudeFailsWhenNpmMissing(t *testing.T) {
	// PATH=empty guarantees no npm is found.
	t.Setenv("PATH", "")
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	err := EnsureClaude(context.Background(), "1.0.40", true, logger)
	if err == nil {
		t.Fatal("expected error when npm missing")
	}
	if !errors.Is(err, err) || err.Error() == "" {
		t.Errorf("err=%v", err)
	}
}

func TestIsPermErr(t *testing.T) {
	cases := []struct {
		name string
		out  string
		err  error
		want bool
	}{
		{"eacces", "npm WARN EACCES /usr/local", errors.New("exit 1"), true},
		{"permission_denied", "permission denied", errors.New("exit 1"), true},
		{"network", "ETIMEDOUT", errors.New("exit 1"), false},
		{"no_err", "anything", nil, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isPermErr([]byte(tc.out), tc.err); got != tc.want {
				t.Errorf("got %v want %v", got, tc.want)
			}
		})
	}
}
