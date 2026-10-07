package agentbus

import (
	"context"
	"strings"
	"testing"
)

func TestPublicationToolsForwardToSessionBroker(t *testing.T) {
	const messageID = "11111111-1111-4111-8111-111111111111"
	const addressID = "22222222-2222-4222-8222-222222222222"
	for _, tc := range []struct {
		name, operation string
		args            map[string]any
	}{
		{"agent_group_list", "groups/list", map[string]any{}},
		{"agent_group_create", "groups/create", map[string]any{"slug": "release.ops", "title": "Release ops", "description": "Selected peers"}},
		{"agent_group_members", "groups/detail", map[string]any{"slug": "release.ops"}},
		{"agent_subscribe", "subscribe", map[string]any{"topic": "group:release.ops"}},
		{"agent_unsubscribe", "unsubscribe", map[string]any{"topic": "agent:" + addressID}},
		{"agent_subscriptions", "subscriptions", map[string]any{}},
		{"agent_publish", "publish", map[string]any{"topic": "group:release.ops", "content": "Release ready", "client_message_id": messageID, "ttl_seconds": float64(120)}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			requests := []recordedRequest{}
			client := newListenClient("", "", &requests)
			if _, err := callMCPTool(context.Background(), client, newChannelTracker(client), tc.name, tc.args); err != nil {
				t.Fatal(err)
			}
			if len(requests) != 1 || !strings.HasSuffix(requests[0].path, "/agent-messaging/"+tc.operation) {
				t.Fatalf("wrong session broker operation: %#v", requests)
			}
			for key, want := range tc.args {
				if requests[0].body[key] != want {
					t.Fatalf("wire field %s = %#v, want %#v", key, requests[0].body[key], want)
				}
			}
		})
	}
}

func TestPublicationRetryKeepsClientMessageIdentity(t *testing.T) {
	requests := []recordedRequest{}
	client := newListenClient("", "", &requests)
	args := map[string]any{"topic": "group:ops", "content": "ready", "client_message_id": newUUID()}
	for range 2 {
		if _, err := callPublicationTool(context.Background(), client, "agent_publish", args); err != nil {
			t.Fatal(err)
		}
	}
	if requests[0].body["client_message_id"] != requests[1].body["client_message_id"] {
		t.Fatal("retry changed publication identity")
	}
	delete(args, "client_message_id")
	if _, err := callPublicationTool(context.Background(), client, "agent_publish", args); err != nil {
		t.Fatal(err)
	}
	if !publicationUUIDPattern.MatchString(requests[2].body["client_message_id"].(string)) {
		t.Fatal("publication did not generate a wire UUID")
	}
}

func TestInvalidPublicationInputDoesNotReachBroker(t *testing.T) {
	for _, args := range []map[string]any{
		{"topic": "*", "content": "hi"},
		{"topic": "group:*", "content": "hi"},
		{"topic": "agent:bad", "content": "hi"},
		{"topic": "group:ops", "content": " "},
		{"topic": "group:ops", "content": strings.Repeat("é", maxPublicationBodyBytes/2+1)},
		{"topic": "group:ops", "content": "hi", "client_message_id": ""},
		{"topic": "group:ops", "content": "hi", "ttl_seconds": float64(59)},
	} {
		requests := []recordedRequest{}
		if _, err := callPublicationTool(context.Background(), newListenClient("", "", &requests), "agent_publish", args); err == nil {
			t.Fatalf("invalid input accepted: %#v", args)
		}
		if len(requests) != 0 {
			t.Fatal("invalid publication reached broker")
		}
	}
}
