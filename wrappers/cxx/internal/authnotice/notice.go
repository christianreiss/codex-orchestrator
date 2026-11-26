// Package authnotice carries credential-change notices to active local sessions.
// It stores opaque generations, never credentials, and never signals or restarts
// native processes. Those clients reload disk credentials on their own auth paths.
package authnotice

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/sessionnotice"
)

type Notice struct {
	Generation string    `json:"generation"`
	Engine     string    `json:"engine"`
	UpdatedAt  time.Time `json:"updated_at"`
	// Detail replaces the generic text for a live account switch. Older
	// binaries ignore it and show the generic credential-update notice.
	Detail string `json:"detail,omitempty"`
}

func (n Notice) Message() string {
	if n.Detail != "" {
		return n.Detail
	}
	name, command := "Codex", "cdx"
	if n.Engine == "claude" {
		name, command = "Claude", "clx"
	}
	if n.Engine == "grok" {
		name, command = "Grok", "cgx"
	}
	if n.Engine == "kimi" {
		name, command = "Kimi Code", "ckx"
	}
	return fmt.Sprintf("Managed %s credentials were updated on disk. The native client can reload them during token refresh or authentication recovery. If authentication remains blocked, resume the session through %s to load the current credentials.", name, command)
}

// Delivery reserves one session's next notice while it is being written. It
// holds no publisher lock and must be committed only after output succeeds.
type Delivery = sessionnotice.Delivery[Notice]

// mailbox lives under ~/.cache/codex-orchestrator/auth-notices; the directory
// name and the Notice JSON are read by concurrently running older binaries.
var mailbox = &sessionnotice.Mailbox[Notice]{
	Dir:   "auth-notices",
	Label: "auth notice",
	Header: func(n Notice) sessionnotice.Header {
		return sessionnotice.Header{Generation: n.Generation, Engine: n.Engine, UpdatedAt: n.UpdatedAt}
	},
}

// Publish deduplicates all writers of the same exact adopted generation.
func Publish(engine, generation string) error {
	decoded, err := hex.DecodeString(generation)
	if err != nil || len(decoded) != sha256.Size {
		return errors.New("invalid auth notice generation")
	}
	return mailbox.Publish(engine, generation, func(Notice) Notice {
		return Notice{Generation: generation, Engine: engine, UpdatedAt: time.Now().UTC()}
	})
}

// PublishDetail publishes a generation with model-facing text of its own,
// used when a live account switch changed which account the credentials name.
func PublishDetail(engine, generation, detail string) error {
	decoded, err := hex.DecodeString(generation)
	if err != nil || len(decoded) != sha256.Size {
		return errors.New("invalid auth notice generation")
	}
	return mailbox.Publish(engine, generation, func(Notice) Notice {
		return Notice{Generation: generation, Engine: engine, UpdatedAt: time.Now().UTC(), Detail: detail}
	})
}

// Prepare allows concurrent sessions to receive the same change, but prevents
// competing hook/MCP consumers in one session from emitting it concurrently.
func Prepare(engine, session string) (*Delivery, error) {
	return mailbox.Prepare(engine, session)
}

// Prime suppresses a notice that predates this session. Later updates remain
// eligible for delivery through its prompt hook or agent MCP connection.
func Prime(engine, session string) error {
	return mailbox.Prime(engine, session)
}
