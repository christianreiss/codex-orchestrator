//go:build linux

package residency

import (
	"context"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestPinnedProcessRequiresExactUserBytesAndActualExit(t *testing.T) {
	cmd := exec.Command("sleep", "30")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cmd.Process.Kill(); cmd.Wait() })
	digest, err := DigestFile("/proc/" + strconv.Itoa(cmd.Process.Pid) + "/exe")
	if err != nil {
		t.Fatal(err)
	}
	if p, err := PinProcess(cmd.Process.Pid, os.Getuid()+1, digest); err == nil {
		p.Close()
		t.Fatal("foreign user accepted")
	}
	if p, err := PinProcess(cmd.Process.Pid, os.Getuid(), strings.Repeat("0", 64)); err == nil {
		p.Close()
		t.Fatal("wrong binary accepted")
	}
	p, err := PinProcess(cmd.Process.Pid, os.Getuid(), digest)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if err := p.WaitExited(ctx); err == nil {
		t.Fatal("live process reported exited")
	}
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	ctx2, cancel2 := context.WithTimeout(context.Background(), time.Second)
	defer cancel2()
	if err := p.WaitExited(ctx2); err != nil {
		t.Fatal(err)
	}
	if p.Start == "" || p.Boot == "" {
		t.Fatal("missing durable identity")
	}
}
