/**
 * Live fleet engine state for components.
 *
 * Call during component initialisation: it creates the svelte-query
 * subscription, which needs the QueryClient context. Every caller shares the
 * `["settings", "engine-state"]` key, so mounting it in many places costs one
 * request; the WS `engine.state.changed` and `settings.changed` events keep it
 * current across tabs.
 */
import { derived, type Readable } from "svelte/store";
import { engineStateQuery } from "$lib/api/settings";
import { fleetEngineView, type FleetEngineView } from "./fleet-state";

export { FLEET_DISABLED_TAG, fleetDisabledTitle, type FleetEngineView } from "./fleet-state";

export function useFleetEngines(): Readable<FleetEngineView> {
  return derived(engineStateQuery(), ($query) => fleetEngineView($query.data));
}
