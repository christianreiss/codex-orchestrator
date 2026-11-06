package agentbus

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

func TestPeerRelayLogRateLimitsPerCategory(t *testing.T) {
	var out bytes.Buffer
	now := time.Date(2026, 11, 6, 7, 0, 0, 0, time.UTC)
	log := newPeerRelayLog(&out)
	log.now = func() time.Time { return now }
	step := func(d time.Duration) { now = now.Add(d) }

	log.printf("register", "registration failed: %s", "403 daemon_relay_disabled")
	step(5 * time.Second)
	log.printf("register", "registration failed: %s", "403 daemon_relay_disabled")
	log.printf("config", "configuration unavailable: %s", "timeout")
	step(30 * time.Second)
	log.printf("register", "registration failed: %s", "502 bad gateway") // changed, but within a minute
	step(time.Minute)
	log.printf("register", "registration failed: %s", "502 bad gateway") // changed line after a minute
	step(5 * time.Minute)
	log.printf("register", "registration failed: %s", "502 bad gateway") // unchanged, suppressed
	step(peerRelayLogEvery)
	log.printf("register", "registration failed: %s", "502 bad gateway") // unchanged, repeated after the interval
	log.printf("registered", "registered relay %s", "r1")

	want := []string{
		"registration failed: 403 daemon_relay_disabled",
		"configuration unavailable: timeout",
		"registration failed: 502 bad gateway",
		"registration failed: 502 bad gateway",
		"registered relay r1",
	}
	got := strings.Split(strings.TrimSuffix(out.String(), "\n"), "\n")
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("log lines:\n%s\nwant:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}

func TestPeerRelayLogToleratesNilWriter(t *testing.T) {
	newPeerRelayLog(nil).printf("config", "ignored")
	var log *peerRelayLog
	log.printf("config", "ignored")
}
