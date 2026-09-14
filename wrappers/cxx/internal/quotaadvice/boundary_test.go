package quotaadvice

import (
	"os"
	"strings"
	"testing"
)

// Wiring matters here: otherwise a failed agent exit looks like a failed
// launch and the dispatcher can offer an unintended second agent session.
func TestBothLifecyclesArmOnlyTheFinalAgentLaunch(t *testing.T) {
	for _, engine := range []string{"codex", "claude"} {
		t.Run(engine, func(t *testing.T) {
			data, err := os.ReadFile("../persona/" + engine + "/lifecycle/run.go")
			if err != nil {
				t.Fatal(err)
			}
			source := string(data)
			choice := strings.Index(source, "quotaadvice.BeforeStart(")
			portal := strings.Index(source, "agentportal.Start(")
			arm := strings.Index(source, "quotaadvice.ArmLaunch(ctx)")
			capture := strings.Index(source, engine+".RunCapture")
			if choice < 0 || portal < choice || arm < portal || capture < arm || strings.Count(source, "quotaadvice.ArmLaunch(ctx)") != 1 {
				t.Fatalf("choice/portal/arm/child boundary = %d/%d/%d/%d", choice, portal, arm, capture)
			}
		})
	}
}
