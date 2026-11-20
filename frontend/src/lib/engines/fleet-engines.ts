/**
 * Live fleet engine state for components — the console's single answer to
 * "which engines belong to the fleet".
 *
 * Rule: an engine switched off fleet-wide appears nowhere operational. Iterate
 * `$fleet.enabled` (never the fixed `ENGINES` list) and filter data rows with
 * `$fleet.isEnabled(row.engine)`. Only the Engines management page and the
 * destroy progress may show a switched-off engine;
 * `engine-list-guard.test.ts` enforces this.
 *
 * Fed by `GET /admin/engines/active` (admin.read), so every signed-in viewer
 * gets it. Call during component initialisation: it creates the svelte-query
 * subscription, which needs the QueryClient context. Every caller shares the
 * `["settings", "engine-active"]` key, so mounting it in many places costs one
 * request; the WS `engine.state.changed` and `settings.changed` events keep it
 * current across tabs. Host counts and actors live on `engineStateQuery`.
 */
import { derived, type Readable } from "svelte/store";
import { engineActiveQuery } from "$lib/api/settings";
import { fleetEngineView, type FleetEngineView } from "./fleet-state";

export { FLEET_DISABLED_TAG, fleetDisabledTitle, type FleetEngineView } from "./fleet-state";

export function useFleetEngines(): Readable<FleetEngineView> {
  return derived(engineActiveQuery(), ($query) => fleetEngineView($query.data));
}
