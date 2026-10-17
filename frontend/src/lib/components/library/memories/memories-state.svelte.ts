/**
 * State for the Library's Memories view: URL-driven filters, the graph query,
 * cursor paging, and the delete flow. Must be constructed during component
 * initialisation (it creates queries and effects).
 *
 * URL contract, all on top of `/library?type=memories`:
 *   q, scopes, tags, host, project, engine  filters
 *   view=map (or legacy graph)              relationship map instead of the list
 *   layers=tags,provenance                  optional map layers
 *   node=<id>                               the open inspector
 */
import { untrack } from "svelte";
import { fromStore } from "svelte/store";
import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";
import { goto } from "$app/navigation";
import { page } from "$app/state";
import { toast } from "svelte-sonner";
import { ApiError } from "$lib/api/client";
import {
  memoriesApi,
  memoriesKeys,
  type MemoryGraphNode,
  type MemoryRecord,
  type MemoryScope,
} from "$lib/api/memories";
import { authStore } from "$lib/stores/auth";
import { reactiveOptions } from "$lib/components/projects/reactive-options.svelte";

export type LayerId = "tags" | "provenance";
export const ALL_SCOPES: MemoryScope[] = ["shared", "project", "host"];
export const ALL = "all";
export const PAGE_SIZE = 25;
export const GRAPH_LIMIT = 500;
export const GRAPH_RENDER_LIMIT = 150;

const EMPTY_FACETS = { scopes: [], hosts: [], projects: [], tags: [], engines: [] };

function validScope(value: string): value is MemoryScope {
  return value === "host" || value === "project" || value === "shared";
}

function csv(value: string | null): string[] {
  return [...new Set((value ?? "").split(",").map((part) => part.trim()).filter(Boolean))];
}

export class MemoriesState {
  private qc = useQueryClient();
  private auth = fromStore(authStore);

  // ---- URL-backed filters ----
  scopes = $derived.by<MemoryScope[]>(() => {
    const requested = csv(page.url.searchParams.get("scopes")).filter(validScope);
    return requested.length ? requested : ALL_SCOPES;
  });
  selectedTags = $derived(csv(page.url.searchParams.get("tags")));
  hostFilter = $derived(page.url.searchParams.get("host") ?? ALL);
  projectFilter = $derived(page.url.searchParams.get("project") ?? ALL);
  engineFilter = $derived(page.url.searchParams.get("engine") ?? ALL);
  showMap = $derived(["map", "graph"].includes(page.url.searchParams.get("view") ?? ""));
  layers = $derived(csv(page.url.searchParams.get("layers")) as LayerId[]);
  selectedNodeId = $derived(page.url.searchParams.get("node"));
  urlSearch = $derived(page.url.searchParams.get("q") ?? "");

  // ---- search (debounced into the URL and the query) ----
  searchInput = $state(untrack(() => page.url.searchParams.get("q") ?? ""));
  searchDebounced = $state(untrack(() => (page.url.searchParams.get("q") ?? "").trim()));
  private lastUrlSearch = untrack(() => page.url.searchParams.get("q") ?? "");

  // ---- paging ----
  cursor = $state<string | null>(null);
  cursorHistory = $state<Array<string | null>>([]);
  tablePage = $state(0);
  private previousSignature = "";

  // ---- dialogs ----
  createOpen = $state(false);
  editOpen = $state(false);
  editTarget = $state<MemoryRecord | null>(null);
  appendOpen = $state(false);
  appendTarget = $state<MemoryRecord | null>(null);
  deleteOpen = $state(false);
  deleteTarget = $state<MemoryRecord | null>(null);

  graphParams = $derived({
    scopes: this.scopes,
    q: this.searchDebounced || undefined,
    tags: this.selectedTags.length ? this.selectedTags : undefined,
    host_id: this.hostFilter === ALL ? null : this.hostFilter,
    project_slug: this.projectFilter === ALL ? null : this.projectFilter,
    engine: this.engineFilter === ALL ? null : this.engineFilter,
    limit: GRAPH_LIMIT,
    cursor: this.cursor,
  });

  private graphStore = fromStore(
    createQuery(
      reactiveOptions(() => ({
        queryKey: memoriesKeys.graph(this.graphParams),
        queryFn: () => memoriesApi.graph(this.graphParams),
      })),
    ),
  );
  get query() {
    return this.graphStore.current;
  }

  private deleteStore = fromStore(
    createMutation({
      mutationFn: (memory: MemoryRecord) => memoriesApi.delete(memory.scope, memory.record_id, memory.etag),
      onSuccess: () => {
        toast.success("Memory permanently deleted");
        this.deleteOpen = false;
        this.clearSelection();
        void this.qc.invalidateQueries({ queryKey: memoriesKeys.all });
      },
      onError: (error: unknown) => {
        if (error instanceof ApiError && (error.status === 409 || error.code === "memory_conflict")) {
          this.deleteOpen = false;
          toast.error("This memory changed after you opened it. Reopen it in the inspector before deleting.");
          if (this.deleteTarget) {
            void this.qc.invalidateQueries({
              queryKey: memoriesKeys.detail(this.deleteTarget.scope, this.deleteTarget.record_id),
            });
          }
          return;
        }
        toast.error(error instanceof Error ? error.message : "Could not delete memory");
      },
    }),
  );
  get deleting() {
    return this.deleteStore.current.isPending;
  }
  confirmDelete() {
    if (this.deleteTarget) this.deleteStore.current.mutate(this.deleteTarget);
  }

  // ---- derived views of the graph response ----
  nodes = $derived(this.query.data?.nodes ?? []);
  edges = $derived(this.query.data?.edges ?? []);
  memoryNodes = $derived(this.nodes.filter((node) => node.kind === "memory"));
  private mapMemoryIds = $derived(new Set(this.memoryNodes.slice(0, GRAPH_RENDER_LIMIT).map((node) => node.id)));
  mapEdges = $derived(this.edges.filter((edge) => this.mapMemoryIds.has(edge.source)));
  private mapRelationIds = $derived(new Set(this.mapEdges.flatMap((edge) => [edge.source, edge.target])));
  mapNodes = $derived(
    this.nodes.filter((node) => (node.kind === "memory" ? this.mapMemoryIds.has(node.id) : this.mapRelationIds.has(node.id))),
  );
  facets = $derived(this.query.data?.facets ?? EMPTY_FACETS);
  totals = $derived(this.query.data?.totals ?? { all: 0, shared: 0, project: 0, host: 0 });
  truncatedFacetNames = $derived(
    (["hosts", "projects", "tags"] as const)
      .filter((name) => this.query.data?.facets_truncated?.[name])
      .map((name) => name.slice(0, -1))
      .join(", "),
  );
  tablePageCount = $derived(Math.max(1, Math.ceil(this.memoryNodes.length / PAGE_SIZE)));
  tableRows = $derived(this.memoryNodes.slice(this.tablePage * PAGE_SIZE, (this.tablePage + 1) * PAGE_SIZE));
  serverHasMore = $derived(Boolean(this.query.data?.next_cursor) || this.cursorHistory.length > 0);
  graphIsCapped = $derived(this.memoryNodes.length > GRAPH_RENDER_LIMIT);
  hasFilters = $derived(
    !!this.searchDebounced
      || this.scopes.length !== ALL_SCOPES.length
      || this.selectedTags.length > 0
      || this.hostFilter !== ALL
      || this.projectFilter !== ALL
      || this.engineFilter !== ALL,
  );

  selectedNode = $derived.by<MemoryGraphNode | null>(() => {
    const id = this.selectedNodeId;
    if (!id) return null;
    const found = this.nodes.find((node) => node.id === id || node.node_id === id);
    if (found) return found;
    const match = /^memory:(host|project|shared):(\d+)$/.exec(id);
    if (!match || !validScope(match[1]!)) return null;
    return { id, node_id: id, kind: "memory", label: id, record_id: Number(match[2]), scope: match[1] as MemoryScope };
  });

  // `memory.write` is the fleet-wide grant. Per-record `capabilities` stay in
  // the disjunction because a record can widen what its owner may do with it.
  canCreate = $derived(
    this.auth.current.authenticated
      && (this.auth.current.can("memory.write") || this.memoryNodes.some((node) => node.capabilities?.create)),
  );

  constructor() {
    $effect(() => {
      const next = this.urlSearch;
      if (next === this.lastUrlSearch) return;
      this.lastUrlSearch = next;
      this.searchInput = next;
      this.searchDebounced = next.trim();
    });

    $effect(() => {
      const value = this.searchInput.trim();
      const timer = setTimeout(() => {
        this.searchDebounced = value;
        if (value === untrack(() => this.urlSearch)) return;
        this.updateUrl((url) => {
          if (value) url.searchParams.set("q", value);
          else url.searchParams.delete("q");
        });
      }, 250);
      return () => clearTimeout(timer);
    });

    $effect(() => {
      const signature = [
        ...this.scopes, this.searchDebounced, ...this.selectedTags, this.hostFilter, this.projectFilter, this.engineFilter,
      ].join("|");
      if (this.previousSignature && signature !== this.previousSignature) {
        this.cursor = null;
        this.cursorHistory = [];
        this.tablePage = 0;
      }
      this.previousSignature = signature;
    });

    $effect(() => {
      if (this.tablePage >= this.tablePageCount) this.tablePage = Math.max(0, this.tablePageCount - 1);
    });
  }

  // ---- URL mutations ----
  updateUrl(change: (url: URL) => void): void {
    const url = new URL(page.url);
    change(url);
    void goto(url, { replaceState: true, keepFocus: true, noScroll: true });
  }

  toggleScope(scope: MemoryScope): void {
    const next = this.scopes.includes(scope) ? this.scopes.filter((item) => item !== scope) : [...this.scopes, scope];
    if (!next.length) return;
    this.updateUrl((url) => {
      if (next.length === ALL_SCOPES.length) url.searchParams.delete("scopes");
      else url.searchParams.set("scopes", ALL_SCOPES.filter((item) => next.includes(item)).join(","));
    });
  }

  setFilter(name: "host" | "project" | "engine", value: string): void {
    this.updateUrl((url) => {
      if (value === ALL) url.searchParams.delete(name);
      else url.searchParams.set(name, value);
    });
  }

  toggleTag(tag: string): void {
    const next = this.selectedTags.includes(tag) ? this.selectedTags.filter((value) => value !== tag) : [...this.selectedTags, tag];
    this.updateUrl((url) => {
      if (next.length) url.searchParams.set("tags", next.join(","));
      else url.searchParams.delete("tags");
    });
  }

  setMap(on: boolean): void {
    this.updateUrl((url) => {
      if (on) url.searchParams.set("view", "map");
      else url.searchParams.delete("view");
    });
  }

  toggleLayer(layer: LayerId): void {
    const next = this.layers.includes(layer) ? this.layers.filter((value) => value !== layer) : [...this.layers, layer];
    this.updateUrl((url) => {
      if (next.length) url.searchParams.set("layers", next.join(","));
      else url.searchParams.delete("layers");
    });
  }

  clearFilters(): void {
    this.searchInput = "";
    this.updateUrl((url) => {
      for (const key of ["q", "scopes", "tags", "host", "project", "engine"]) url.searchParams.delete(key);
    });
  }

  selectNode(node: MemoryGraphNode): void {
    if (node.kind !== "memory") return;
    this.updateUrl((url) => url.searchParams.set("node", node.node_id ?? node.id));
  }

  clearSelection(): void {
    this.updateUrl((url) => url.searchParams.delete("node"));
  }

  // ---- paging ----
  nextServerPage(): void {
    const next = this.query.data?.next_cursor;
    if (!next) return;
    this.cursorHistory = [...this.cursorHistory, this.cursor];
    this.cursor = next;
    this.tablePage = 0;
  }

  previousServerPage(): void {
    if (!this.cursorHistory.length) return;
    this.cursor = this.cursorHistory[this.cursorHistory.length - 1] ?? null;
    this.cursorHistory = this.cursorHistory.slice(0, -1);
    this.tablePage = 0;
  }

  // ---- dialogs ----
  openEdit(memory: MemoryRecord): void {
    this.editTarget = memory;
    this.editOpen = true;
  }

  openAppend(memory: MemoryRecord): void {
    this.appendTarget = memory;
    this.appendOpen = true;
  }

  openDelete(memory: MemoryRecord): void {
    this.deleteTarget = memory;
    this.deleteOpen = true;
  }
}
