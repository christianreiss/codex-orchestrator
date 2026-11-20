// Package contentnotice tells active local sessions that fleet-managed content
// changed on disk after they started. Native clients read instructions, settings
// and the Skill list at launch, so a pushed content pass alone never reaches a
// model that is already running. Like authnotice it stores opaque generations,
// never content, and never signals or restarts native processes.
package contentnotice

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/sessionnotice"
)

// Content kinds a pass can change. Instructions and Skills can be picked up by
// the running model; everything else takes effect on the next launch.
const (
	KindInstructions = "instructions"
	KindSkills       = "skills"
	KindConfig       = "config"
)

type Notice struct {
	Generation   string    `json:"generation"`
	Engine       string    `json:"engine"`
	Kinds        []string  `json:"kinds"`
	Digests      Snapshot  `json:"digests,omitempty"`
	Instructions string    `json:"instructions,omitempty"`
	UpdatedAt    time.Time `json:"updated_at"`
}

func (n Notice) has(kind string) bool {
	for _, k := range n.Kinds {
		if k == kind {
			return true
		}
	}
	return false
}

func (n Notice) Message() string {
	var parts []string
	var changed []string
	for _, kind := range n.Kinds {
		label := map[string]string{KindInstructions: "fleet instructions", KindSkills: "Skill catalog", KindConfig: "managed configuration"}[kind]
		if label == "" {
			continue
		}
		if digest := n.Digests[kind]; digest != "" {
			label += " (sha256:" + digest + ")"
		}
		changed = append(changed, label)
	}
	if n.Generation != "" {
		parts = append(parts, "Fleet content generation sha256:"+n.Generation+". Changed: "+strings.Join(changed, ", ")+".")
	}
	if n.has(KindInstructions) {
		file := n.Instructions
		if file == "" {
			file = map[string]string{"codex": "~/.codex/AGENTS.md", "claude": "~/.claude/CLAUDE.md", "grok": "~/.grok/AGENTS.md", "kimi": "~/.kimi-code/AGENTS.md"}[n.Engine]
		}
		parts = append(parts, "The fleet instructions in "+file+" changed since this session's last notice. Re-read that file now; where it differs from what you loaded earlier, the file is current.")
	}
	if n.has(KindSkills) {
		if n.Engine == "grok" {
			parts = append(parts, "Fleet Skills under ~/.grok/skills changed. Re-read a Skill's SKILL.md before relying on what you loaded earlier.")
		} else if n.Engine == "kimi" {
			parts = append(parts, "Fleet Skills under ~/.kimi-code/skills changed. Re-read a Skill's SKILL.md before relying on what you loaded earlier.")
		} else {
			parts = append(parts, "Fleet Skills changed. Call skill_list again and re-read a Skill before relying on what you loaded earlier.")
		}
	}
	if n.has(KindConfig) {
		parts = append(parts, "Managed settings, MCP or native configuration also changed; those take effect on the next launch.")
	}
	return strings.Join(parts, " ")
}

// Snapshot maps a content kind to the digest of the files that carry it.
type Snapshot map[string]string

// Capture digests the named files and directory trees per kind. A missing path
// is part of the digest, so creating or removing a file counts as a change.
func Capture(kinds map[string][]string) Snapshot {
	out := Snapshot{}
	for kind, list := range kinds {
		h := sha256.New()
		for _, root := range list {
			h.Write([]byte(root + "\x00"))
			_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
				if err != nil {
					h.Write([]byte("missing\x00"))
					return nil
				}
				if !d.Type().IsRegular() {
					return nil
				}
				raw, err := os.ReadFile(path)
				if err != nil {
					return nil
				}
				sum := sha256.Sum256(raw)
				h.Write([]byte(path + "\x00" + hex.EncodeToString(sum[:]) + "\x00"))
				return nil
			})
		}
		out[kind] = hex.EncodeToString(h.Sum(nil))
	}
	return out
}

// PublishChanges publishes a notice for every kind whose digest moved between
// two snapshots of one content pass. An unchanged pass publishes nothing.
func PublishChanges(engine, instructions string, before, after Snapshot) error {
	var changed []string
	for kind, digest := range after {
		if before[kind] != digest {
			changed = append(changed, kind)
		}
	}
	if len(changed) == 0 {
		return nil
	}
	sort.Strings(changed)
	keys := make([]string, 0, len(after))
	for kind := range after {
		keys = append(keys, kind)
	}
	sort.Strings(keys)
	h := sha256.New()
	for _, kind := range keys {
		h.Write([]byte(kind + "=" + after[kind] + "\n"))
	}
	return Publish(Notice{Generation: hex.EncodeToString(h.Sum(nil)), Engine: engine, Kinds: changed, Digests: after, Instructions: instructions})
}

// Publish deduplicates all writers of the same exact content generation. A
// newer pass that lands before a session read the previous notice merges its
// kinds, so a session told only about Skills still learns of new instructions.
func Publish(notice Notice) error {
	decoded, err := hex.DecodeString(notice.Generation)
	if err != nil || len(decoded) != sha256.Size || len(notice.Kinds) == 0 {
		return errors.New("invalid content notice")
	}
	return mailbox.Publish(notice.Engine, notice.Generation, func(previous Notice) Notice {
		next := notice
		next.Kinds = append([]string(nil), notice.Kinds...)
		for _, kind := range previous.Kinds {
			if !next.has(kind) {
				next.Kinds = append(next.Kinds, kind)
			}
		}
		sort.Strings(next.Kinds)
		next.UpdatedAt = time.Now().UTC()
		return next
	})
}

// Delivery reserves one session's next notice while it is being written. It
// holds no publisher lock and must be committed only after output succeeds.
type Delivery = sessionnotice.Delivery[Notice]

// seenGeneration is the <session>.seen.json companion of the plain ledger.
type seenGeneration struct {
	Generation string   `json:"generation"`
	Digests    Snapshot `json:"digests,omitempty"`
}

// mailbox lives under ~/.cache/codex-orchestrator/content-notices; the
// directory name, the Notice JSON and the plain ledger are read by concurrently
// running older binaries.
var mailbox = &sessionnotice.Mailbox[Notice]{
	Dir:   "content-notices",
	Label: "content notice",
	Header: func(n Notice) sessionnotice.Header {
		return sessionnotice.Header{Generation: n.Generation, Engine: n.Engine, UpdatedAt: n.UpdatedAt}
	},
	Complete: func(n Notice) bool { return len(n.Kinds) > 0 },
	Companion: func(n Notice) ([]byte, error) {
		return json.Marshal(seenGeneration{Generation: n.Generation, Digests: n.Digests})
	},
	Narrow: func(notice Notice, seen string, companion []byte) (Notice, bool) {
		var previous seenGeneration
		if companion != nil {
			_ = json.Unmarshal(companion, &previous)
		}
		if previous.Generation != seen {
			// Older consumers record no category metadata. Conservatively emit
			// one full notice rather than relying on stale companion digests.
			previous = seenGeneration{}
		}
		if len(previous.Digests) > 0 && len(notice.Digests) > 0 {
			var changed []string
			for _, kind := range notice.Kinds {
				if previous.Digests[kind] != notice.Digests[kind] {
					changed = append(changed, kind)
				}
			}
			if len(changed) == 0 {
				return notice, false
			}
			notice.Kinds = changed
		}
		return notice, true
	},
}

// Prepare lets concurrent sessions receive the same change, but prevents
// competing hook/MCP consumers in one session from emitting it twice.
func Prepare(engine, session string) (*Delivery, error) {
	return mailbox.Prepare(engine, session)
}

// Prime suppresses a notice that predates this session: it launched with the
// content already on disk. Later passes remain eligible for delivery.
func Prime(engine, session string) error {
	return mailbox.Prime(engine, session)
}
