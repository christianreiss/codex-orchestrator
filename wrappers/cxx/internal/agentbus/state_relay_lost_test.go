package agentbus

import (
	"errors"
	"fmt"
	"testing"
)

func TestRelayRegistrationLostOnlyForUncurableRefusals(t *testing.T) {
	for _, tc := range []struct {
		err  error
		want bool
	}{
		{&APIError{Status: 401, Code: "unauthorized"}, true},
		{&APIError{Status: 403, Code: "forbidden"}, true},
		{fmt.Errorf("claim: %w", &APIError{Status: 409, Code: "agent_messaging_relay_detached"}), true},
		{&APIError{Status: 409, Code: "agent_messaging_lease_lost"}, true},
		{&APIError{Status: 409, Code: "agent_messaging_message_expired"}, false},
		{&APIError{Status: 503, Code: "owner_unavailable"}, false},
		{errors.New("dial tcp: connection refused"), false},
	} {
		if got := relayRegistrationLost(tc.err); got != tc.want {
			t.Errorf("relayRegistrationLost(%v) = %v, want %v", tc.err, got, tc.want)
		}
	}
}
