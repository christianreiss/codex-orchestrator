package agentbus

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

func chatTools() []map[string]any {
	text := func() map[string]any { return map[string]any{"type": "string"} }
	ids := map[string]any{"type": "array", "maxItems": 10, "items": map[string]any{"type": "string", "format": "uuid"}}
	uuid := func() map[string]any { return map[string]any{"type": "string", "format": "uuid"} }
	return []map[string]any{
		tool("agent_portal_ask", "Ask the operator in the existing agent chat. Choose buttons, text or both. Normal questions do not imply Needs you. Retain client_event_id and prompt_id on retries. severity and notice_id explicitly mark important/critical/blocker.", map[string]any{"client_event_id": uuid(), "prompt_id": uuid(), "question": text(), "summary": text(), "answer_mode": map[string]any{"type": "string", "enum": []string{"buttons", "text", "both"}}, "choices": map[string]any{"type": "array", "maxItems": 20, "items": map[string]any{"type": "object", "properties": map[string]any{"label": text(), "value": text()}, "required": []string{"label", "value"}}}, "severity": map[string]any{"type": "string", "enum": []string{"important", "critical", "blocker"}}, "notice_id": uuid(), "attachments": ids}, []string{"client_event_id", "prompt_id", "question", "answer_mode"}),
		tool("agent_portal_notify", "Mark important, critical or blocker in the operator agent chat. Requires a reason in summary. It remains until explicitly resolved, including offline. Retain notice_id and client_event_id on retries; reuse notice_id to escalate.", map[string]any{"client_event_id": uuid(), "notice_id": uuid(), "severity": map[string]any{"type": "string", "enum": []string{"important", "critical", "blocker"}}, "summary": text()}, []string{"client_event_id", "notice_id", "severity", "summary"}),
		tool("agent_portal_resolve", "Resolve only the identified Needs you notice in this operator conversation. Does not answer a question. Retain client_event_id on retries.", map[string]any{"client_event_id": uuid(), "notice_id": uuid(), "summary": text()}, []string{"client_event_id", "notice_id"}),
		tool("agent_attachment_upload", "Upload a local file to this operator agent chat, then use its ID in agent_receiver_reply or agent_portal_ask attachments. Retain upload_id on retry. Original local files are preserved.", map[string]any{"upload_id": uuid(), "path": text(), "mime_type": text()}, []string{"upload_id", "path", "mime_type"}),
		tool("agent_attachment_get", "Fetch an operator chat attachment or a prepared transcript/video frame to a local file. Returns metadata, processing state and local_path. Use the local file with your image/file tools. No automatic execution. Originals remain available if processing failed. variant is original, transcript.json or frame-NN.jpg.", map[string]any{"attachment_id": uuid(), "variant": text()}, []string{"attachment_id"}),
	}
}

func callChatTool(ctx context.Context, client *sessionClient, name string, args map[string]any) (map[string]any, error) {
	var out map[string]any
	if name == "agent_attachment_upload" {
		id, path := stringArg(args, "upload_id"), stringArg(args, "path")
		if id == "" || path == "" {
			return nil, errors.New("upload_id and path required")
		}
		file, err := os.Open(path)
		if err != nil {
			return nil, err
		}
		defer file.Close()
		info, err := file.Stat()
		if err != nil {
			return nil, err
		}
		if !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > 100*1024*1024 {
			return nil, errors.New("attachment must be a regular file up to 100 MiB")
		}
		h := sha256.New()
		if _, err = io.Copy(h, file); err != nil {
			return nil, err
		}
		digest := hex.EncodeToString(h.Sum(nil))
		_, _ = file.Seek(0, 0)
		if err = client.sessionPost(ctx, "attachments", map[string]any{"id": id, "name": filepath.Base(path), "mime_type": stringArg(args, "mime_type"), "size_bytes": info.Size(), "sha256": digest}, &out); err != nil {
			return nil, fmt.Errorf("upload %s: %w", id, err)
		}
		buf := make([]byte, 4*1024*1024)
		offset := int64(intArg(out, "uploaded_bytes", 0))
		if offset < 0 || offset > info.Size() {
			return nil, errors.New("invalid upload offset")
		}
		if _, err = file.Seek(offset, 0); err != nil {
			return nil, err
		}
		for {
			n, e := file.Read(buf)
			if n > 0 {
				err = client.sessionPost(ctx, "attachments/"+id+"/chunks", map[string]any{"offset": offset, "content_b64": base64.StdEncoding.EncodeToString(buf[:n])}, &out)
				if err != nil {
					return nil, fmt.Errorf("retry upload_id %s: %w", id, err)
				}
				offset += int64(n)
			}
			if e == io.EOF {
				break
			}
			if e != nil {
				return nil, e
			}
		}
		err = client.sessionPost(ctx, "attachments/"+id+"/seal", map[string]any{}, &out)
		return out, err
	}
	if name == "agent_attachment_get" {
		id := stringArg(args, "attachment_id")
		variant := stringArg(args, "variant")
		if variant == "" {
			variant = "original"
		}
		if !safeChatID(id) || !(variant == "original" || variant == "transcript.json" || strings.HasPrefix(variant, "frame-")) {
			return nil, errors.New("invalid attachment ID or variant")
		}
		dir, err := os.MkdirTemp("", "cxx-chat-")
		if err != nil {
			return nil, err
		}
		path := filepath.Join(dir, "attachment")
		file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return nil, err
		}
		success := false
		defer func() {
			file.Close()
			if !success {
				os.RemoveAll(dir)
			}
		}()
		h := sha256.New()
		var offset int64
		for {
			if err = client.sessionPost(ctx, "attachments/get", map[string]any{"attachment_id": id, "variant": variant, "offset": offset}, &out); err != nil {
				return nil, err
			}
			bytes, e := base64.StdEncoding.DecodeString(stringArg(out, "content_b64"))
			if e != nil {
				return nil, e
			}
			if len(bytes) == 0 && !boolArg(out, "done") {
				return nil, errors.New("empty download chunk")
			}
			if _, err = file.Write(bytes); err != nil {
				return nil, err
			}
			h.Write(bytes)
			offset += int64(len(bytes))
			if boolArg(out, "done") {
				break
			}
		}
		digest := hex.EncodeToString(h.Sum(nil))
		if variant == "original" && digest != stringArg(out, "sha256") {
			return nil, errors.New("attachment checksum mismatch")
		}
		if err = file.Sync(); err != nil {
			return nil, err
		}
		success = true
		delete(out, "content_b64")
		out["local_path"] = path
		out["download_sha256"] = digest
		return out, nil
	}
	payload := map[string]any{}
	copyOptional(args, payload, "question", "summary", "answer_mode", "choices", "prompt_id", "severity", "notice_id", "attachments")
	kind := "attention"
	if name == "agent_portal_ask" {
		kind = "waiting_input"
		payload["allow_answer"] = true
	}
	if name == "agent_portal_resolve" {
		kind = "attention_resolved"
	}
	err := client.sessionPost(ctx, "events", map[string]any{"client_event_id": stringArg(args, "client_event_id"), "type": kind, "payload": payload}, &out)
	if err == nil && name == "agent_portal_ask" {
		err = client.sessionPost(ctx, "heartbeat", map[string]any{"active_turn_id": ""}, nil)
	}
	return out, err
}
func safeChatID(id string) bool {
	if len(id) != 36 {
		return false
	}
	for _, c := range id {
		if !(c == '-' || c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}
