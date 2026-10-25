//go:build unix

package agentbus

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestManagedMCPWriterInheritedSocketChild(t *testing.T) {
	mode := os.Getenv("CXX_TEST_INHERITED_SOCKET")
	if mode == "" {
		return
	}
	// This is an exec-inherited blocking fd, not os.Pipe/net.Pipe initialized by Go.
	if err := os.Stdout.SetWriteDeadline(time.Now().Add(time.Second)); err == nil {
		t.Fatal("fixture stdout was already pollable")
	}
	output, closeOutput := managedMCPWriter(os.Stdout)
	if !output.supportsGuardedWrite() {
		t.Fatal("inherited socket was not made pollable")
	}
	if mode == "success" {
		if err := output.send(map[string]string{"phase": "normal-before"}); err != nil {
			t.Fatal(err)
		}
		if attempted, err := output.sendGuarded(context.Background(), time.Now().Add(250*time.Millisecond), map[string]string{"phase": "bounded"}); !attempted || err != nil {
			t.Fatal(attempted, err)
		}
		time.Sleep(270 * time.Millisecond)
		if err := output.send(map[string]string{"phase": "normal-after"}); err != nil {
			t.Fatal(err)
		}
		closeOutput()
		if _, err := os.Stdout.Stat(); err != nil {
			t.Fatal(err)
		}
		os.Exit(0)
	}
	counted := &countedInheritedSocket{Conn: output.w.(net.Conn)}
	output.w = counted
	if err := output.send(map[string]string{"phase": "normal-before"}); err != nil {
		t.Fatal(err)
	}
	fmt.Fprintln(os.Stderr, "prepared")
	// Parent deliberately leaves stdout unread until the bounded write ends.
	start := time.Now()
	attempted, err := output.sendGuarded(context.Background(), start.Add(250*time.Millisecond), map[string]string{"content": strings.Repeat("x", 8<<20)})
	if !attempted || err == nil || time.Since(start) > time.Second {
		t.Fatalf("attempted=%v err=%v elapsed=%v", attempted, err, time.Since(start))
	}
	fmt.Fprintln(os.Stderr, "deadline-expired")
	if _, err := bufio.NewReader(os.Stdin).ReadString('\n'); err != nil {
		t.Fatal(err)
	}
	calls := counted.calls
	if err := output.send(map[string]string{"phase": "normal-after"}); !errors.Is(err, errMCPWriterPoisoned) {
		t.Fatalf("later normal write not fenced: %v", err)
	}
	if attempted, err := output.sendGuarded(context.Background(), time.Now().Add(time.Second), map[string]string{"phase": "guarded-after"}); attempted || !errors.Is(err, errMCPWriterPoisoned) {
		t.Fatalf("later guard not fenced: %v %v", attempted, err)
	}
	if output.supportsGuardedWrite() || counted.calls != calls {
		t.Fatalf("poisoned writer touched native fd: %d -> %d", calls, counted.calls)
	}
	closeOutput()
	if _, err := os.Stdout.Stat(); err != nil {
		t.Fatal("closed borrowed stdout", err)
	}
	fmt.Fprintln(os.Stderr, "done")
	os.Exit(0)
}

func TestManagedMCPWriterHandlesActualExecInheritedSocketpair(t *testing.T) {
	pair, err := unix.Socketpair(unix.AF_UNIX, unix.SOCK_STREAM, 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := unix.SetsockoptInt(pair[1], unix.SOL_SOCKET, unix.SO_SNDBUF, 4096); err != nil {
		t.Fatal(err)
	}
	peer := os.NewFile(uintptr(pair[0]), "native-peer")
	defer peer.Close()
	childOutput := os.NewFile(uintptr(pair[1]), "inherited-stdout")
	defer childOutput.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestManagedMCPWriterInheritedSocketChild$")
	cmd.Env = append(os.Environ(), "CXX_TEST_INHERITED_SOCKET=1")
	cmd.Stdout = childOutput
	input, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	childOutput.Close()
	control := bufio.NewReader(stderr)
	if line, err := control.ReadString('\n'); err != nil || line != "prepared\n" {
		t.Fatalf("startup=%q %v", line, err)
	}
	// Drain the first normal frame, then leave the socket blocked during guard.
	stream := bufio.NewReader(peer)
	var before map[string]string
	line, err := stream.ReadString('\n')
	if err != nil || json.Unmarshal([]byte(line), &before) != nil || before["phase"] != "normal-before" {
		t.Fatalf("normal before=%q %v", line, err)
	}
	if line, err := control.ReadString('\n'); err != nil || line != "deadline-expired\n" {
		t.Fatalf("deadline=%q %v", line, err)
	}
	drained := make(chan []byte, 1)
	go func() { body, _ := io.ReadAll(stream); drained <- body }()
	fmt.Fprintln(input, "resume")
	input.Close()
	if line, err := control.ReadString('\n'); err != nil || line != "done\n" {
		t.Fatalf("completion=%q %v", line, err)
	}
	if err := cmd.Wait(); err != nil {
		t.Fatal(err)
	}
	if body := <-drained; len(body) == 0 || bytes.Contains(body, []byte("\n")) || bytes.Contains(body, []byte("normal-after")) || bytes.Contains(body, []byte("guarded-after")) {
		t.Fatalf("partial frame was followed by more protocol bytes: %q", body[:min(len(body), 80)])
	}
}

type countedInheritedSocket struct {
	net.Conn
	calls int
}

func (w *countedInheritedSocket) Write(data []byte) (int, error) {
	w.calls++
	return w.Conn.Write(data)
}

func TestManagedMCPWriterSuccessfulInheritedSocketFramesRemainValidNDJSON(t *testing.T) {
	pair, err := unix.Socketpair(unix.AF_UNIX, unix.SOCK_STREAM, 0)
	if err != nil {
		t.Fatal(err)
	}
	peer := os.NewFile(uintptr(pair[0]), "native-peer")
	defer peer.Close()
	child := os.NewFile(uintptr(pair[1]), "inherited-stdout")
	defer child.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestManagedMCPWriterInheritedSocketChild$")
	cmd.Env = append(os.Environ(), "CXX_TEST_INHERITED_SOCKET=success")
	cmd.Stdout = child
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	child.Close()
	input := bufio.NewReader(peer)
	for _, phase := range []string{"normal-before", "bounded", "normal-after"} {
		line, err := input.ReadString('\n')
		if err != nil {
			t.Fatal(err, stderr.String())
		}
		var frame map[string]string
		if json.Unmarshal([]byte(line), &frame) != nil || len(frame) != 1 || frame["phase"] != phase {
			t.Fatalf("invalid NDJSON %q", line)
		}
	}
	if trailing, err := io.ReadAll(input); err != nil || len(trailing) != 0 {
		t.Fatalf("extra protocol bytes %q %v", trailing, err)
	}
	if err := cmd.Wait(); err != nil {
		t.Fatal(err, stderr.String())
	}
}
