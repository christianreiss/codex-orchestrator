/**
 * Filter state for the Activity feed, mirrored to the URL so a filtered view
 * is shareable. Legacy `/logs/*` links arrive here with the same parameter
 * names (`q`, `host`, `window`, `prefix`, `status`), plus `type`.
 */
import { goto } from "$app/navigation";
import {
  parseHost,
  parseStatus,
  parseType,
  parseWindow,
  type ActivityType,
  type TimeWindow,
  type ToolStatus,
} from "./event-model";

export class ActivityFilters {
  type = $state<ActivityType>("changes");
  q = $state("");
  host = $state("all");
  window = $state<TimeWindow>("all");
  /** Action (changes) or tool-name (tools) prefix. */
  action = $state("");
  status = $state<ToolStatus>("all");
  page = $state(1);

  constructor(params: URLSearchParams) {
    this.type = parseType(params.get("type"));
    this.q = params.get("q") ?? "";
    this.host = parseHost(params.get("host"));
    this.window = parseWindow(params.get("window"));
    this.action = params.get("prefix") ?? "";
    this.status = parseStatus(params.get("status"));
  }

  /** Switching the data source drops the filters that only make sense for the other one. */
  setType(next: ActivityType): void {
    if (next === this.type) return;
    this.type = next;
    this.action = "";
    this.status = "all";
    if (next === "tools" && this.host === "system") this.host = "all";
  }

  get active(): boolean {
    return this.q.trim() !== "" || this.host !== "all" || this.window !== "all" || this.action !== "" || this.status !== "all";
  }

  reset(): void {
    this.q = "";
    this.host = "all";
    this.window = "all";
    this.action = "";
    this.status = "all";
  }

  /** Bring the address bar in line with the filters; call from an `$effect`. */
  syncUrl(current: URL): void {
    const url = new URL(current);
    const sp = url.searchParams;
    const put = (key: string, value: string, fallback: string) => {
      if (value === fallback) sp.delete(key);
      else sp.set(key, value);
    };
    put("type", this.type, "changes");
    put("q", this.q, "");
    put("host", this.host, "all");
    put("window", this.window, "all");
    put("prefix", this.action, "");
    put("status", this.status, "all");
    if (url.search !== current.search) void goto(url, { replaceState: true, keepFocus: true, noScroll: true });
  }
}
