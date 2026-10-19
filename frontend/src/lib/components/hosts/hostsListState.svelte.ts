/**
 * URL-synced state for the hosts list: one status filter, optional attribute
 * filters ("More filters"), search and sort. Construct it during component
 * init (it registers an effect for the debounced search).
 */
import { page } from "$app/state";
import { goto } from "$app/navigation";
import {
  hostLastSeenMs,
  hostMatchesFilter,
  hostStatusKind,
  hostStatusLabel,
  type HostFilterId,
} from "$lib/api/hosts";
import type { HostListItem } from "$lib/api/types";
import { attentionCount, hostAttention, type AttentionItem } from "./hostAttention";

export type StatusFilter = "all" | "online" | "offline" | "attention";
export type FlagFilter = "vip" | "roaming" | "secure" | "insecure" | "unprovisioned";
export type SortField = "fqdn" | "last_refresh" | "attention";
export type SortDir = "asc" | "desc";

export const STATUS_OPTIONS: Array<{ id: StatusFilter; label: string }> = [
  { id: "all", label: "All hosts" },
  { id: "online", label: "Online" },
  { id: "offline", label: "Offline" },
  { id: "attention", label: "Needs attention" },
];

export const FLAG_OPTIONS: Array<{ id: FlagFilter; label: string; hint: string }> = [
  { id: "vip", label: "Priority hosts", hint: "VIP" },
  { id: "roaming", label: "Allows IP changes", hint: "roaming" },
  { id: "secure", label: "Trusted hosts", hint: "secure" },
  { id: "insecure", label: "Untrusted hosts", hint: "insecure" },
  { id: "unprovisioned", label: "Not signed in yet", hint: "unprovisioned" },
];

const STATUS_IDS = STATUS_OPTIONS.map((o) => o.id);
const FLAG_IDS = FLAG_OPTIONS.map((o) => o.id);
const SORT_FIELDS: SortField[] = ["fqdn", "last_refresh", "attention"];

export interface HostRow {
  host: HostListItem;
  items: AttentionItem[];
  attention: number;
}

function matchesQuery(h: HostListItem, q: string): boolean {
  const hay = [
    h.fqdn,
    String(h.id),
    h.ip4,
    h.ip6,
    h.client_version_override ?? h.client_version,
    h.claude_client_version_override ?? h.claude_client_version,
    h.grok_client_version_override ?? h.grok_client_version,
    h.status,
    hostStatusLabel(h),
  ];
  return hay.some((v) => (v ?? "").toLowerCase().includes(q));
}

export class HostsListState {
  now = $state(Date.now());
  readonly #hosts: () => HostListItem[];
  readonly #pending: () => ReadonlySet<number>;
  readonly #disabled: () => readonly string[];

  search = $state(page.url.searchParams.get("q") ?? "");
  #query = $state((page.url.searchParams.get("q") ?? "").trim().toLowerCase());

  constructor(hosts: () => HostListItem[], pending: () => ReadonlySet<number>, disabled: () => readonly string[]) {
    $effect(() => {
      const timer = setInterval(() => { this.now = Date.now(); }, 1000);
      return () => clearInterval(timer);
    });
    this.#hosts = hosts;
    this.#pending = pending;
    this.#disabled = disabled;
    $effect(() => {
      const value = this.search.trim().toLowerCase();
      const timer = setTimeout(() => {
        this.#query = value;
        if ((page.url.searchParams.get("q") ?? "") === value) return;
        this.#patch((url) => (value ? url.searchParams.set("q", value) : url.searchParams.delete("q")));
      }, 200);
      return () => clearTimeout(timer);
    });
  }

  status = $derived.by<StatusFilter>(() => {
    const params = page.url.searchParams;
    const s = params.get("status") ?? params.get("filter") ?? "all";
    return (STATUS_IDS as string[]).includes(s) ? (s as StatusFilter) : "all";
  });

  flags = $derived.by<FlagFilter[]>(() => {
    const params = page.url.searchParams;
    const legacy = params.get("filter");
    const raw = [...(params.get("flag") ?? "").split(","), legacy ?? ""];
    return Array.from(new Set(raw.filter((f): f is FlagFilter => (FLAG_IDS as string[]).includes(f))));
  });

  sortField = $derived.by<SortField>(() => {
    const f = page.url.searchParams.get("sort") ?? "fqdn";
    return (SORT_FIELDS as string[]).includes(f) ? (f as SortField) : "fqdn";
  });

  sortDir = $derived.by<SortDir>(() => (page.url.searchParams.get("dir") === "desc" ? "desc" : "asc"));

  /** Every host with its attention items, unfiltered. */
  all = $derived.by<HostRow[]>(() => {
    const pending = this.#pending();
    const disabled = this.#disabled();
    return this.#hosts().map((host) => {
      const items = hostAttention(host, { pendingApproval: pending.has(host.id), disabledEngines: disabled });
      return { host, items, attention: attentionCount(items) };
    });
  });

  counts = $derived({
    total: this.all.length,
    online: this.all.filter((r) => hostStatusKind(r.host, this.now) === "online").length,
    offline: this.all.filter((r) => hostStatusKind(r.host, this.now) === "offline").length,
    attention: this.all.filter((r) => r.attention > 0).length,
  });

  /** True when a search, status or attribute filter is narrowing the list. */
  filtered = $derived(this.status !== "all" || this.flags.length > 0 || this.#query !== "");

  rows = $derived.by<HostRow[]>(() => {
    const q = this.#query;
    const list = this.all.filter((r) => {
      if (this.status === "attention") {
        if (r.attention === 0) return false;
      } else if (this.status !== "all" && !hostMatchesFilter(r.host, this.status as HostFilterId, this.now)) {
        return false;
      }
      if (!this.flags.every((flag) => hostMatchesFilter(r.host, flag, this.now))) return false;
      return !q || matchesQuery(r.host, q);
    });
    const dir = this.sortDir === "asc" ? 1 : -1;
    return list.sort((a, b) => {
      if (this.sortField === "last_refresh") {
        const av = hostLastSeenMs(a.host);
        const bv = hostLastSeenMs(b.host);
        if (av === bv) return 0;
        if (av === null) return 1;
        if (bv === null) return -1;
        return (av - bv) * dir;
      }
      if (this.sortField === "attention") return (a.attention - b.attention) * dir || a.host.fqdn.localeCompare(b.host.fqdn);
      return a.host.fqdn.localeCompare(b.host.fqdn) * dir;
    });
  });

  #patch(change: (url: URL) => void): void {
    const url = new URL(page.url);
    change(url);
    // A legacy `filter` param is folded into status/flag the first time anything changes.
    url.searchParams.delete("filter");
    void goto(url, { replaceState: true, keepFocus: true, noScroll: true });
  }

  setStatus(value: StatusFilter): void {
    this.#patch((url) => {
      if (value === "all") url.searchParams.delete("status");
      else url.searchParams.set("status", value);
      this.#writeFlags(url, this.flags);
    });
  }

  toggleFlag(flag: FlagFilter): void {
    const next = this.flags.includes(flag) ? this.flags.filter((f) => f !== flag) : [...this.flags, flag];
    this.#patch((url) => {
      this.#writeFlags(url, next);
      if (this.status !== "all") url.searchParams.set("status", this.status);
    });
  }

  #writeFlags(url: URL, flags: FlagFilter[]): void {
    if (flags.length) url.searchParams.set("flag", flags.join(","));
    else url.searchParams.delete("flag");
  }

  setSort(field: SortField): void {
    const dir: SortDir = this.sortField === field ? (this.sortDir === "asc" ? "desc" : "asc") : "asc";
    this.#patch((url) => {
      if (field === "fqdn") url.searchParams.delete("sort");
      else url.searchParams.set("sort", field);
      if (dir === "asc") url.searchParams.delete("dir");
      else url.searchParams.set("dir", dir);
    });
  }

  clear(): void {
    this.search = "";
    this.#query = "";
    this.#patch((url) => {
      for (const key of ["q", "status", "flag"]) url.searchParams.delete(key);
    });
  }
}
