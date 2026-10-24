/**
 * Filter state for the Activity feed, mirrored to the URL so a filtered view
 * is shareable. Legacy `/logs/*` links arrive here with the same parameter
 * names (`q`, `host`, `window`, `prefix`). Retired tool-only parameters are removed.
 */
import { goto } from "$app/navigation";
import {
  parseHost,
  parseWindow,
  type TimeWindow,
} from "./event-model";

export class ActivityFilters {
  q = $state("");
  host = $state("all");
  window = $state<TimeWindow>("all");
  /** Action prefix. */
  action = $state("");
  page = $state(1);

  constructor(params: URLSearchParams) {
    this.q = params.get("q") ?? "";
    this.host = parseHost(params.get("host"));
    this.window = parseWindow(params.get("window"));
    this.action = params.get("prefix") ?? "";
  }

  get active(): boolean {
    return this.q.trim() !== "" || this.host !== "all" || this.window !== "all" || this.action !== "";
  }

  reset(): void {
    this.q = "";
    this.host = "all";
    this.window = "all";
    this.action = "";
  }

  /** Bring the address bar in line with the filters; call from an `$effect`. */
  syncUrl(current: URL): void {
    const url = new URL(current);
    const sp = url.searchParams;
    const put = (key: string, value: string, fallback: string) => {
      if (value === fallback) sp.delete(key);
      else sp.set(key, value);
    };
    sp.delete("type");
    sp.delete("status");
    put("q", this.q, "");
    put("host", this.host, "all");
    put("window", this.window, "all");
    put("prefix", this.action, "");
    if (url.search !== current.search) void goto(url, { replaceState: true, keepFocus: true, noScroll: true });
  }
}
