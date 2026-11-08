package rtk

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"runtime"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/signing"
)

func Command(args []string, engine string, in io.Reader, out, stderr io.Writer) int {
	if len(args) > 0 && args[0] == "exec" {
		return Exec(context.Background(), args[1:], in, out, stderr)
	}
	jsonOut := false
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "status":
		case "--json":
			jsonOut = true
		case "--engine":
			i++
			if i == len(args) {
				return 2
			}
			engine = args[i]
		default:
			fmt.Fprintln(stderr, "usage: cxx rtk status [--engine codex|claude|grok] [--json]")
			return 2
		}
	}
	engines := []string{engine}
	if engine == "" {
		engines = []string{"codex", "claude", "grok"}
	}
	key, e := signing.PublicKey()
	if e != nil {
		fmt.Fprintln(stderr, e)
		return 1
	}
	var result []map[string]any
	for _, engine := range engines {
		if engine != "codex" && engine != "claude" && engine != "grok" {
			return 2
		}
		r := map[string]any{"engine": engine, "requested": false, "available": false, "rtk_version": Version, "mode": "instructions"}
		if engine == "codex" {
			r["mode"] = "instructions"
		}
		p, e := config.DefaultPathForEngine(engine)
		if e == nil {
			var cfg *config.Config
			cfg, e = config.LoadForEngine(p, key, false, engine)
			if e == nil && cfg.RTK != nil {
				r["requested"] = cfg.RTK.Enabled && !cfg.EngineSuspended(engine)
				r["policy_revision"] = cfg.RTK.PolicyRevision
				bin, err := binaryPath()
				if err == nil {
					_, err = os.Stat(bin)
				}
				a, ok := cfg.RTK.Artifacts[runtime.GOOS+"/"+runtime.GOARCH]
				r["available"] = err == nil && ok && verifiedCache(bin, a.SHA256)
			}
		}
		if e != nil {
			r["error_code"] = "unavailable"
		}
		result = append(result, r)
	}
	if jsonOut {
		json.NewEncoder(out).Encode(result)
	} else {
		for _, r := range result {
			fmt.Fprintf(out, "%s: requested=%v installed=%v mode=%s RTK %s\n", r["engine"], r["requested"], r["available"], r["mode"], Version)
		}
	}
	return 0
}
