package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/launchpad"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
)

// Re-load the selected engine's signed config for each request. In particular,
// never reuse another engine's credentials, CA or endpoint from the hub.
type fleetDefaultsClient struct {
	load func(string) (*config.Config, error)
}

func (c fleetDefaultsClient) Get(ctx context.Context, engine string) (launchpad.FleetDefault, error) {
	return c.request(ctx, engine, http.MethodGet, nil)
}

func (c fleetDefaultsClient) Set(ctx context.Context, s launchpad.Selection) (launchpad.FleetDefault, error) {
	var effort any
	if s.Effort != "" {
		effort = s.Effort
	}
	return c.request(ctx, s.Engine, http.MethodPost, map[string]any{"model": s.Model, "reasoning_effort": effort})
}

func (c fleetDefaultsClient) request(ctx context.Context, engine, method string, body any) (launchpad.FleetDefault, error) {
	switch engine {
	case config.EngineCodex, config.EngineClaude, config.EngineGrok, config.EngineKimi:
	default:
		return launchpad.FleetDefault{}, fmt.Errorf("%w: unknown engine", launchpad.ErrDefaultsRejected)
	}
	cfg, err := c.load(engine)
	if err != nil {
		return launchpad.FleetDefault{}, fmt.Errorf("%w: cannot load signed engine config", launchpad.ErrDefaultsRejected)
	}
	client, err := updateClient(cfg)
	if err != nil {
		return launchpad.FleetDefault{}, fmt.Errorf("%w: cannot initialize fleet connection", launchpad.ErrDefaultsRejected)
	}
	defer client.HTTP.CloseIdleConnections()
	if method == http.MethodPost {
		// Even a same-origin 307/308 would replay the mutation.
		client.HTTP.CheckRedirect = func(*http.Request, []*http.Request) error {
			return errors.New("fleet-default POST redirect refused")
		}
	}
	var response struct {
		launchpad.FleetDefault
		Data *launchpad.FleetDefault `json:"data"`
	}
	err = client.JSON(ctx, method, "/host/model-defaults/"+engine, body, &response, 0)
	if err != nil {
		var status *orchestrator.HTTPError
		if errors.As(err, &status) {
			if status.StatusCode == http.StatusNotFound || status.StatusCode == http.StatusMethodNotAllowed {
				return launchpad.FleetDefault{}, launchpad.ErrDefaultsUnavailable
			}
			if status.StatusCode >= 400 && status.StatusCode < 500 && status.StatusCode != http.StatusRequestTimeout {
				// Admission can be revoked after the write commits, before the
				// response is released. Confirm once rather than treating that
				// response denial as proof that nothing changed.
				if method == http.MethodPost && status.StatusCode != http.StatusUnprocessableEntity && status.StatusCode != http.StatusConflict {
					return launchpad.FleetDefault{}, fmt.Errorf("fleet save response denied (HTTP %d, %s)", status.StatusCode, status.Code)
				}
				return launchpad.FleetDefault{}, fmt.Errorf("%w (HTTP %d, %s)", launchpad.ErrDefaultsRejected, status.StatusCode, status.Code)
			}
			return launchpad.FleetDefault{}, fmt.Errorf("fleet request failed (HTTP %d)", status.StatusCode)
		}
		return launchpad.FleetDefault{}, errors.New("fleet connection failed or timed out")
	}
	value := response.FleetDefault
	if response.Data != nil {
		value = *response.Data
	}
	if value.Engine != engine || value.Model == "" {
		return launchpad.FleetDefault{}, errors.New("invalid fleet-default reply")
	}
	return value, nil
}
