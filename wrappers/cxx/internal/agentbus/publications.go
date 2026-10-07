package agentbus

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"unicode/utf8"
)

var groupSlugPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)
var publicationUUIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

const maxPublicationBodyBytes = 30 * 1024

func validPublicationTopic(topic string) bool {
	if strings.HasPrefix(topic, "group:") {
		return groupSlugPattern.MatchString(strings.TrimPrefix(topic, "group:"))
	}
	return strings.HasPrefix(topic, "agent:") && publicationUUIDPattern.MatchString(strings.TrimPrefix(topic, "agent:"))
}

// Publication tools use the same private, session-bound broker as direct
// messages. There is no fleet-wide wildcard and no route to private traffic.
func callPublicationTool(ctx context.Context, client *sessionClient, name string, args map[string]any) (map[string]any, error) {
	body := map[string]any{}
	operation := ""
	switch name {
	case "agent_group_list":
		operation = "groups/list"
	case "agent_subscriptions":
		operation = "subscriptions"
	case "agent_group_create", "agent_group_members":
		slug := stringArg(args, "slug")
		if !groupSlugPattern.MatchString(slug) {
			return nil, errors.New("slug must be 1–64 lowercase letters, digits, dots, underscores or hyphens, starting with a letter or digit")
		}
		body["slug"] = slug
		operation = "groups/detail"
		if name == "agent_group_create" {
			title := strings.TrimSpace(stringArg(args, "title"))
			if title == "" || utf8.RuneCountInString(title) > 120 {
				return nil, errors.New("title must be 1–120 characters")
			}
			if utf8.RuneCountInString(stringArg(args, "description")) > 1000 {
				return nil, errors.New("description must be at most 1000 characters")
			}
			body["title"] = title
			copyOptional(args, body, "description")
			operation = "groups/create"
		}
	case "agent_subscribe", "agent_unsubscribe", "agent_publish":
		topic := stringArg(args, "topic")
		if !validPublicationTopic(topic) {
			return nil, errors.New("topic must be group:<slug> or agent:<uuid>; wildcards are not supported")
		}
		body["topic"] = topic
		operation = strings.TrimPrefix(name, "agent_")
		if name == "agent_publish" {
			content := stringArg(args, "content")
			if strings.TrimSpace(content) == "" || len(content) > maxPublicationBodyBytes {
				return nil, errors.New("publication content must be nonempty and at most 30720 bytes")
			}
			messageID := stringArg(args, "client_message_id")
			if _, present := args["client_message_id"]; present && !publicationUUIDPattern.MatchString(messageID) {
				return nil, errors.New("client_message_id must be a UUID")
			}
			if messageID == "" {
				messageID = newUUID()
			}
			body["client_message_id"], body["content"] = messageID, content
			if ttl, present := args["ttl_seconds"]; present && ttl != nil {
				seconds := intArg(args, "ttl_seconds", -1)
				if seconds < 60 || seconds > 604800 {
					return nil, errors.New("ttl_seconds must be between 60 and 604800")
				}
				body["ttl_seconds"] = seconds
			}
		}
	default:
		return nil, errors.New("unknown publication tool")
	}
	var out map[string]any
	if err := client.post(ctx, operation, body, &out); err != nil {
		return nil, err
	}
	return out, nil
}
