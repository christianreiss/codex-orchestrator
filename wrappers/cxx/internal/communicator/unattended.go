package communicator

import (
	"context"
	"net/http"
)

// UnattendedHeader marks a request no human is waiting on: the owner's own
// scheduled resync. On an insecure host whose window is closed the server
// refuses such a request without opening an approval nobody could answer
// (a stuck scope otherwise raised an operator prompt every retry).
const UnattendedHeader = "X-Cxx-Unattended"

type unattendedKey struct{}

// WithUnattended marks every orchestrator request made under ctx as unattended.
func WithUnattended(ctx context.Context) context.Context {
	return context.WithValue(ctx, unattendedKey{}, true)
}

// SetUnattendedHeader stamps the marker when ctx carries it.
func SetUnattendedHeader(ctx context.Context, h http.Header) {
	if h != nil && ctx != nil && ctx.Value(unattendedKey{}) == true {
		h.Set(UnattendedHeader, "1")
	}
}
