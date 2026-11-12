// Package libcselect converges Linux engine binaries independently of their version.
package libcselect

import (
	"bytes"
	"context"
	"crypto/sha256"
	"debug/elf"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"syscall"
	"time"
)

const (
	GNU     = "glibc"
	Musl    = "musl"
	Unknown = "unknown"
)

var ErrUnavailable = errors.New("libc artifact unavailable")
var ErrIntegrity = errors.New("package integrity verification failed")

type incompatible struct{ err error }

func (e *incompatible) Error() string { return e.err.Error() }
func (e *incompatible) Unwrap() error { return e.err }
func Incompatible(err error) error    { return &incompatible{err} }
func MayFallback(err error) bool {
	var e *incompatible
	return errors.Is(err, ErrUnavailable) || errors.As(err, &e)
}

type Host struct {
	GNU         bool
	Fingerprint string
}
type hostKey struct{}

// WithHost supplies deterministic platform evidence to installer integration tests.
func WithHost(ctx context.Context, host Host) context.Context {
	return context.WithValue(ctx, hostKey{}, host)
}
func Detect(ctx context.Context) Host {
	if h, ok := ctx.Value(hostKey{}).(Host); ok {
		return h
	}
	h := Host{}
	var evidence []string
	for _, p := range []string{"/lib64/ld-linux-x86-64.so.2", "/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2", "/lib/ld-linux-aarch64.so.1", "/lib/aarch64-linux-gnu/ld-linux-aarch64.so.1"} {
		f, err := elf.Open(p)
		if err != nil {
			continue
		}
		machine := elf.EM_X86_64
		if runtime.GOARCH == "arm64" {
			machine = elf.EM_AARCH64
		}
		valid := f.Machine == machine
		f.Close()
		if !valid {
			continue
		}
		probe, cancel := context.WithTimeout(ctx, 2*time.Second)
		out, err := exec.CommandContext(probe, p, "--version").CombinedOutput()
		cancel()
		if err == nil && (strings.Contains(string(out), "GLIBC") || strings.Contains(string(out), "GNU libc")) {
			real, _ := filepath.EvalSymlinks(p)
			info, statErr := os.Stat(p)
			if statErr != nil {
				continue
			}
			h.GNU = true
			evidence = append(evidence, fmt.Sprint(real, info.Size(), info.ModTime().UnixNano(), string(out)))
			break
		}
	}
	sum := sha256.Sum256([]byte(runtime.GOOS + "/" + runtime.GOARCH + "/" + strings.Join(evidence, "/")))
	h.Fingerprint = hex.EncodeToString(sum[:])
	return h
}

// Inspect never calls a provider CLI. A static ELF without provider evidence is unknown.
func Inspect(path string) string {
	f, err := elf.Open(path)
	if err != nil {
		return Unknown
	}
	defer f.Close()
	for _, p := range f.Progs {
		if p.Type == elf.PT_INTERP {
			if p.Filesz > 4096 {
				return Unknown
			}
			b := make([]byte, p.Filesz)
			if _, err := p.ReadAt(b, 0); err != nil {
				return Unknown
			}
			if strings.Contains(string(b), "ld-musl-") {
				return Musl
			}
			if strings.Contains(string(b), "ld-linux") {
				return GNU
			}
		}
	}
	return Unknown
}

var loaderFailure = regexp.MustCompile(`(?i)(?:GLIBC_[0-9.]+.*not found|error while loading shared libraries: [^\r\n]+|Error loading shared library [^\r\n]+|Error relocating [^\r\n]+: symbol not found)`)

// Probe distinguishes demonstrated loader incompatibility from arbitrary CLI failure.
func Probe(ctx context.Context, path string, args ...string) ([]byte, error) {
	probe, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if binary, e := elf.Open(path); e == nil {
		expected := elf.EM_X86_64
		if runtime.GOARCH == "arm64" {
			expected = elf.EM_AARCH64
		}
		machine := binary.Machine
		binary.Close()
		if machine != expected {
			return nil, errors.New("staged ELF architecture does not match host")
		}
	}
	cmd := exec.CommandContext(probe, path, args...)
	output := &boundedOutput{}
	cmd.Stdout = output
	cmd.Stderr = output
	err := cmd.Run()
	out := output.Bytes()
	if err == nil {
		return out, nil
	}
	if probe.Err() != nil {
		return nil, probe.Err()
	}
	if errors.Is(err, syscall.ENOENT) {
		if _, statErr := os.Stat(path); statErr == nil {
			return nil, Incompatible(fmt.Errorf("executable loader missing"))
		}
	}
	if match := loaderFailure.Find(out); match != nil {
		return nil, Incompatible(fmt.Errorf("%s", match))
	}
	return nil, fmt.Errorf("staged executable probe failed: %w", err)
}

type boundedOutput struct{ bytes.Buffer }

func (b *boundedOutput) Write(p []byte) (int, error) {
	n := len(p)
	remaining := (64 << 10) - b.Len()
	if remaining > 0 {
		_, _ = b.Buffer.Write(p[:min(remaining, n)])
	}
	return n, nil
}
