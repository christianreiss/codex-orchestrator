package agentbus

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"
)

var nativeNameID = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,255}$`)

// Read only the bound native session's naming metadata. Never infer a name
// from transcript text or send conversation contents to the overview.
func nativeSessionName(home, engine, id string) string {
	if !nativeNameID.MatchString(id) {
		return ""
	}
	var name string
	switch engine {
	case "codex":
		root := os.Getenv("CODEX_HOME")
		if root == "" {
			root = filepath.Join(home, ".codex")
		}
		scanNameRecords(filepath.Join(root, "session_index.jsonl"), "thread_name", func(row map[string]any) {
			if row["id"] == id {
				name, _ = row["thread_name"].(string)
			}
		})
	case "claude":
		root := os.Getenv("CLAUDE_CONFIG_DIR")
		if root == "" {
			root = filepath.Join(home, ".claude")
		}
		paths, _ := filepath.Glob(filepath.Join(root, "projects", "*", id+".jsonl"))
		if len(paths) != 1 {
			return ""
		}
		scanNameRecords(paths[0], "customTitle", func(row map[string]any) {
			if row["sessionId"] == id && row["type"] == "custom-title" {
				name, _ = row["customTitle"].(string)
			}
		})
	case "grok":
		root := os.Getenv("GROK_HOME")
		if root == "" {
			root = filepath.Join(home, ".grok")
		}
		paths, _ := filepath.Glob(filepath.Join(root, "sessions", "*", id, "summary.json"))
		if len(paths) != 1 {
			return ""
		}
		f, err := os.Open(paths[0])
		if err != nil {
			return ""
		}
		defer f.Close()
		var row struct {
			Info struct {
				ID string `json:"id"`
			} `json:"info"`
			Title          string `json:"title"`
			GeneratedTitle string `json:"generated_title"`
		}
		if json.NewDecoder(io.LimitReader(f, 1<<20)).Decode(&row) == nil && row.Info.ID == id {
			name = row.Title
			if strings.TrimSpace(name) == "" {
				name = row.GeneratedTitle
			}
		}
	}
	name = strings.Join(strings.Fields(name), " ")
	if utf8.RuneCountInString(name) > 160 {
		name = string([]rune(name)[:159]) + "…"
	}
	return name
}

func scanNameRecords(path, key string, visit func(map[string]any)) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	scanner := bufio.NewScanner(io.LimitReader(f, 128<<20))
	scanner.Buffer(make([]byte, 64<<10), 8<<20)
	for scanner.Scan() {
		if !bytes.Contains(scanner.Bytes(), []byte(`"`+key+`"`)) {
			continue
		}
		var row map[string]any
		if json.Unmarshal(scanner.Bytes(), &row) == nil {
			visit(row)
		}
	}
}

type sessionNameReporter struct {
	nativeID    string
	lastName    string
	pendingID   string
	pendingName string
}

type nativeSessionTitleWriter interface{ setSessionName(string, string) error }

// Claude persists /rename and --name as append-only custom-title metadata.
// Only the exact, already-existing bound transcript is eligible; no conversation
// records are rewritten and a partially written tail is retried later.
type claudeSessionTitleWriter struct{}

func (claudeSessionTitleWriter) setSessionName(id, name string) error {
	if !nativeNameID.MatchString(id) {
		return errors.New("invalid native session ID")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	root := os.Getenv("CLAUDE_CONFIG_DIR")
	if root == "" {
		root = filepath.Join(home, ".claude")
	}
	paths, _ := filepath.Glob(filepath.Join(root, "projects", "*", id+".jsonl"))
	if len(paths) != 1 {
		return errors.New("bound Claude transcript unavailable")
	}
	f, err := os.OpenFile(paths[0], os.O_APPEND|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return errors.New("bound Claude transcript is not a regular file")
	}
	if info.Size() > 0 {
		var tail [1]byte
		if _, err := f.ReadAt(tail[:], info.Size()-1); err != nil {
			return err
		}
		if tail[0] != '\n' {
			return errors.New("bound Claude transcript has an incomplete record")
		}
	}
	raw, err := json.Marshal(map[string]string{"type": "custom-title", "sessionId": id, "customTitle": name})
	if err != nil {
		return err
	}
	if _, err = f.Write(append(raw, '\n')); err != nil {
		return err
	}
	return f.Sync()
}

type ownIdentity struct {
	Name          string   `json:"name"`
	SessionID     string   `json:"session_id"`
	NativeID      string   `json:"native_session_id"`
	Engine        string   `json:"engine"`
	PreviousNames []string `json:"previous_names"`
	TaskTitle     string   `json:"task_title"`
}

func bareSessionTitle(title string, identity ownIdentity) string {
	for {
		previous := title
		for _, name := range append([]string{identity.Name}, identity.PreviousNames...) {
			prefix := "(" + name + ")"
			if title == prefix || strings.HasPrefix(title, prefix+" ") {
				title = strings.TrimSpace(strings.TrimPrefix(title, prefix))
				break
			}
		}
		if previous == title {
			return title
		}
	}
}

func (r *sessionNameReporter) report(ctx context.Context, client *sessionClient, engine, nativeID string, writers ...nativeSessionTitleWriter) {
	if r.nativeID != nativeID {
		*r = sessionNameReporter{nativeID: nativeID}
	}
	if r.pendingID == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return
		}
		name := nativeSessionName(home, engine, nativeID)
		if len(writers) > 0 && writers[0] != nil {
			var identity ownIdentity
			if client.post(ctx, "self", map[string]any{}, &identity) != nil || identity.SessionID != client.id || identity.NativeID != nativeID || identity.Engine != engine || identity.Name == "" {
				return
			}
			task := bareSessionTitle(name, identity)
			if task == "" {
				task = bareSessionTitle(identity.TaskTitle, identity)
			}
			named := "(" + identity.Name + ")"
			if task != "" {
				named += " " + task
			}
			if name != named && writers[0].setSessionName(nativeID, named) != nil {
				return
			}
			name = task
		}
		if name == "" || name == r.lastName {
			return
		}
		r.pendingID, r.pendingName = newUUID(), name
	}
	body := map[string]any{"client_event_id": r.pendingID, "type": "session_named", "payload": map[string]any{"name": r.pendingName, "native_session_id": nativeID}}
	if client.sessionPost(ctx, "events", body, nil) == nil {
		r.lastName = r.pendingName
		r.pendingID, r.pendingName = "", ""
	}
}

func assignSessionName(ctx context.Context, client *sessionClient, args map[string]any) (map[string]any, error) {
	name := strings.Join(strings.Fields(stringArg(args, "name")), " ")
	if name == "" || utf8.RuneCountInString(name) > 160 {
		return nil, errors.New("name must contain 1–160 characters")
	}
	body := map[string]any{"client_event_id": newUUID(), "type": "session_named", "payload": map[string]any{"name": name, "only_if_missing": true}}
	var out map[string]any
	err := client.sessionPost(ctx, "events", body, &out)
	if err != nil {
		err = client.sessionPost(ctx, "events", body, &out)
	}
	if err != nil {
		return nil, err
	}
	return out, nil
}
