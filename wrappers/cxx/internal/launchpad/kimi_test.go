package launchpad

import (
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"strings"
	"testing"
)

func TestKimiNativeArgsAndFourthSlot(t *testing.T) {
	for _, tc := range []struct {
		mode Mode
		flag string
	}{{ModeContinue, "-c"}, {ModePick, "-S"}} {
		args := NativeArgs(Selection{Engine: config.EngineKimi, Model: "kimi-code/k3", Effort: "max", Mode: tc.mode})
		if strings.Join(args, " ") != "-m kimi-code/k3 "+tc.flag {
			t.Fatal(args)
		}
	}
	if len(slotKeys) != 4 || slotKeys[3][0] != "up" {
		t.Fatal("fourth engine unreachable", slotKeys)
	}
}

func kimiEngine() Engine {
	return Engine{Name: config.EngineKimi, Model: "kimi-code/k3", Effort: "high", Models: []Model{{ID: "kimi-code/k3", Efforts: []string{"low", "high", "max"}, DefaultEffort: "high"}}}
}
