/**
 * State for the merged Agents page: one set of filters, one selection and one
 * inspector shared by the Live (conversation workspace) and Graph (topology)
 * views. Must be constructed during component initialisation (it owns queries
 * and effects).
 */
import { onMount, untrack } from "svelte";
import { fromStore } from "svelte/store";
import { page } from "$app/state";
import { goto, replaceState } from "$app/navigation";
import { topologyQuery, type Topology } from "$lib/api/topology";
import { emptyGhostState, filterGraph, graphModel, summarize, trackGhosts, type GhostState } from "$lib/topology/model";
import type TopologyGraph from "./TopologyGraph.svelte";

export type AgentsViewName = "live" | "graph";
type Engine = "all" | "codex" | "claude" | "grok";

const PREFS_KEY = "topology-view-v1";

class AgentsView {
  readonly topology = fromStore(topologyQuery());

  // One shared filter row.
  search = $state("");
  engine = $state<Engine>("all");
  // Live view.
  workspace = $state<"agents" | "remote">("agents");
  startRemote = $state(false);
  liveSelectedId = $state<string | null>(null);
  // Graph view.
  grouping = $state<'project' | 'host' | 'connection' | 'scopes'>('connection');
  layout = $state<"radial" | "list">("radial");
  status = $state("all");
  host = $state("all");
  mode = $state("all");
  collapsed = $state(new Set<string>());
  fullscreen = $state(false);
  graph = $state<TopologyGraph>();
  // The conversation drawer that sits beside the graph.
  chatId = $state<string | null>(null);
  chatOpen = $state(false);
  spawnHost = $state<number | undefined>();
  spawnOpen = $state(false);

  now = $state(Date.now());
  ghostState = $state<GhostState>(emptyGhostState());
  selectedId = $state<string | null>(page.url.searchParams.get("node"));
  #latest: Topology | undefined;
  #prefsLoaded = $state(false);

  view = $derived<AgentsViewName>(page.url.searchParams.get("view") === "graph" ? "graph" : "live");
  model = $derived(graphModel(this.topology.current.data, this.ghostState, this.now));
  visibleModel = $derived(
    filterGraph(this.model, { engine: this.engine, status: this.status, host: this.host, mode: this.mode }, this.collapsed),
  );
  summary = $derived(summarize(this.topology.current.data));
  selectedItem = $derived(
    this.selectedId ? ([...this.model.communicators, ...this.model.agents].find((item) => item.node.id === this.selectedId) ?? null) : null,
  );
  filtersActive = $derived(
    this.search !== "" || this.engine !== "all" || this.status !== "all" || this.host !== "all" || this.mode !== "all" || this.collapsed.size > 0,
  );

  constructor() {
    $effect(() => {
      const timer = setInterval(() => (this.now = Date.now()), 1000);
      return () => clearInterval(timer);
    });
    // Nodes that just left stay on the canvas, faded, for a few seconds.
    $effect(() => {
      const data = this.topology.current.data;
      if (!data) return;
      this.#latest = data;
      this.ghostState = trackGhosts(untrack(() => this.ghostState), data, Date.now());
    });
    // Ghosts also age out on the clock, not only when the next snapshot lands.
    $effect(() => {
      void this.now;
      const current = untrack(() => this.ghostState);
      if (current.ghosts.size === 0 || !this.#latest) return;
      const next = trackGhosts(current, this.#latest, Date.now());
      if (next.ghosts.size !== current.ghosts.size) this.ghostState = next;
    });
    // A selection that no longer exists (and has no ghost) is dropped.
    $effect(() => {
      if (this.selectedId && this.topology.current.data && !this.selectedItem) this.select(null);
    });
    onMount(() => {
      try {
        const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null");
        if (saved?.view === "list" || saved?.view === "radial") this.layout = saved.view;
        if (['project', 'host', 'connection', 'scopes'].includes(saved?.grouping)) this.grouping = saved.grouping;
        const f = saved?.filters;
        if (f) {
          if (typeof f.engine === "string") this.engine = f.engine;
          if (typeof f.status === "string") this.status = f.status;
          if (typeof f.host === "string") this.host = f.host;
          if (typeof f.mode === "string") this.mode = f.mode;
        }
      } catch { /* Storage is optional. */ }
      this.#prefsLoaded = true;
    });
    $effect(() => {
      if (!this.#prefsLoaded) return;
      const payload = JSON.stringify({ view: this.layout, grouping: this.grouping, filters: { engine: this.engine, status: this.status, host: this.host, mode: this.mode } });
      try { localStorage.setItem(PREFS_KEY, payload); } catch { /* Storage is optional. */ }
    });
  }

  setView(next: AgentsViewName) {
    const url = new URL(page.url);
    if (next === "graph") url.searchParams.set("view", "graph");
    else url.searchParams.delete("view");
    void goto(url, { keepFocus: true, noScroll: true });
  }

  select(id: string | null) {
    this.selectedId = id;
    const url = new URL(page.url);
    if (id) url.searchParams.set("node", id);
    else url.searchParams.delete("node");
    try {
      replaceState(url, {});
    } catch {
      /* The router is not ready during the first paint; selection still works. */
    }
  }

  openChat(id: string) {
    this.select(null);
    this.chatId = id;
    this.chatOpen = true;
  }

  startAgent(host?: number) {
    this.select(null);
    this.spawnHost = host;
    this.spawnOpen = true;
    this.chatOpen = true;
  }

  toggleCollapsed(id: string) {
    const next = new Set(this.collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.collapsed = next;
  }

  resetFilters() {
    this.search = "";
    this.engine = "all";
    this.status = "all";
    this.host = "all";
    this.mode = "all";
    this.collapsed = new Set();
  }
}

export type { AgentsView };
export function createAgentsView(): AgentsView {
  return new AgentsView();
}
