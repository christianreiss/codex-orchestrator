/**
 * WebSocket event → svelte-query invalidation map.
 *
 * Single source of truth for which query keys get invalidated by which
 * WS event types. Consolidated after Phase 2 feature merges.
 *
 * `api/test/unit/ws/event-invalidation-coverage.test.ts` reads this map and
 * fails when the API publishes an event type that has no entry here;
 * `api/test/unit/routes/ws-invalidation-key-liveness.test.ts` fails when an
 * entry names a query key root nothing under `frontend/src` queries.
 */
import type { QueryClient, QueryKey } from "@tanstack/svelte-query";
import type { Readable } from "svelte/store";
import { toast } from "svelte-sonner";
import type { WsEvent } from "./client";

export type WsInvalidationMap = Record<string, QueryKey[]>;

/** Default invalidation map. */
export const DEFAULT_INVALIDATIONS: WsInvalidationMap = {
  "auth.canonical": [["accounts"]],
  "auth.invalidated": [["accounts"]],
  "communicator.updated": [["communicators"], ["topology"]],
  "communicator.disconnected": [["communicators"], ["topology"]],
  "communicator.terminated": [["communicators"], ["topology"]],
  'feedback.changed': [['feedback'], ['agents']],
  "chatty.settings": [["chatty"]],
 "host.daemon.changed": [["host-daemons"], ["daemon-sessions"], ["topology"]],
 "host.daemon.configured": [["host-daemons"]],
 "host.daemon.start_requested": [["host-daemons"], ["daemon-sessions"]],
 "host.daemon.stop_requested": [["host-daemons"], ["daemon-sessions"], ["topology"]],
  // A reconnect has no durable WS replay; resample retained client snapshots.
  "transport.connected": [["agent-sessions"], ["agent-messaging"], ["host-daemons"], ["daemon-sessions"], ["topology"]],
  "agent_portal.sessions.changed": [["agent-sessions"], ["topology"]],
  "agent_session.native_stop": [["agent-sessions"], ["topology"], ["native-stop"]],
  // Logs
  "log.created": [["logs"], ["logs", "api"], ["logs", "events"]],
  "log.updated": [["logs"], ["logs", "events"]],
  "mcp.invoked": [["logs", "mcp"]],

  // Hosts + overview dashboard counters
  // `setup` too: the checklist counts registered and synced hosts, and the
  // installer-progress view in the wizard reads both.
  "version.wrapper_rollout": [["wrapper-rollout"], ["topology"]],
  "version.wrapper_rollout_advanced": [["wrapper-rollout"], ["topology"]],
  "host.updated": [["hosts"], ["overview"], ["agent-messaging"], ["setup"], ["host-daemons"], ["topology"]],
  "host.created": [["hosts"], ["overview"], ["setup"]],
  "host.deleted": [["hosts"], ["overview"], ["agent-messaging"]],
  "host.pruned": [["hosts"], ["overview"], ["agent-messaging"]],

  // Users
  "user.updated": [["users"]],
  "user.created": [["users"]],
  "user.deleted": [["users"]],
  // Bulk delete of every admin user except the actor.
  "admin.user.wipe": [["users"]],

  // Projects (both list and project-scoped detail; per-project keys handled in wireWsToQueryClient)
  "project.changed": [["projects"]],
  "project.updated": [["projects"]],
  "project.created": [["projects"]],
  "project.deleted": [["projects"]],
  "project.note.created": [["projects"]],
  "project.note.updated": [["projects"]],
  "project.note.deleted": [["projects"]],
  "project.todo.created": [["projects"]],
  "project.todo.updated": [["projects"]],
  "project.todo.deleted": [["projects"]],
  "project.file.upserted": [["projects"]],
  "project.file.updated": [["projects"]],
  "project.file.deleted": [["projects"]],
  "project.feedback.created": [["projects"]],
  "project.feedback.updated": [["projects"]],
  "project.archived": [["projects"]],
  "project.unarchived": [["projects"]],
  "project.card.created": [["projects"]],
  "project.card.updated": [["projects"]],
  "project.card.moved": [["projects"]],
  "project.card.claimed": [["projects"]],
  "project.card.released": [["projects"]],
  "project.card.deleted": [["projects"]],
  "project.board.updated": [["projects"]],
  "project_board.module_toggled": [["projects"], ["projects", "board", "state"]],
  "project_board.claim_force_released": [["projects"]],

  // Authoring (the authoring pages query the bare ["agents"]/["skills"]/["memories"] keys)
  "agents.stored": [["agents"]],
  "skill.updated": [["skills"]],
  "skill.stored": [["skills"]],
  "skill.deleted": [["skills"]],
  "memory.changed": [["memories"]],
  "memory.created": [["memories"]],
  "memory.updated": [["memories"]],
  "memory.appended": [["memories"]],
  "memory.deleted": [["memories"]],
  "project.memory.created": [["memories"], ["projects"]],
  "project.memory.updated": [["memories"], ["projects"]],
  "project.memory.deleted": [["memories"], ["projects"]],
  "shared_memory.changed": [["memories"]],
  "shared_memory.created": [["memories"]],
  "shared_memory.updated": [["memories"]],
  "shared_memory.appended": [["memories"]],
  "shared_memory.deleted": [["memories"]],

  // Claude artifacts (subagents / slash-commands / output-styles)
  "claude_artifact.stored": [["subagents"], ["commands"], ["output-styles"]],
  "claude_artifact.updated": [["subagents"], ["commands"], ["output-styles"]],
  "claude_artifact.deleted": [["subagents"], ["commands"], ["output-styles"]],

  // API keys
  "api-key.changed": [
    ["keys", "openai"],
    ["keys", "claude"],
    ["keys", "grok"],
  ],
  "apikey.created": [
    ["keys", "openai"],
    ["keys", "claude"],
    ["keys", "grok"],
  ],
  "apikey.toggled": [
    ["keys", "openai"],
    ["keys", "claude"],
    ["keys", "grok"],
  ],
  "apikey.deleted": [
    ["keys", "openai"],
    ["keys", "claude"],
    ["keys", "grok"],
  ],

  // Fleet secrets. The module card shows a live count, so every mutation
  // refreshes the state key as well as the listing. `secret.revealed` is
  // published with broadcast:false on purpose — a human reading a credential is
  // an audit fact, not a reason to nudge any UI into re-fetching.
  // NB: keep apostrophes and other bare quote characters out of comments in
  // this object. The coverage test scans quote characters at depth 0 to find
  // the keys, so a stray one swallows every entry that follows it.
  "secret.created": [
    ["secrets", "list"],
    ["secrets", "state"],
  ],
  "secret.updated": [
    ["secrets", "list"],
    ["secrets", "state"],
  ],
  "secret.deleted": [
    ["secrets", "list"],
    ["secrets", "state"],
  ],
  "secret.module_toggled": [
    ["secrets", "state"],
    ["secrets", "list"],
  ],

  // Settings (root key triggers hierarchical match on all per-setting keys)
  // Source checks update their state even when the imported catalogue itself
  // is unchanged, so keep the source card live across tabs and worker ticks.
  "companion.devices.changed": [["companion-devices"]],
  "accounts.updated": [["accounts"], ["overview"], ["hosts"]],
  "host.spawn.state_changed": [["settings", "host-spawn"], ["hosts"]],
  "settings.changed": [["settings"], ["claude-settings"], ["hosts"], ["skills", "source"], ["keys", "openai", "state"], ["keys", "claude", "state"], ["keys", "grok", "state"]],
  // Fleet engine master switch. Settings covers the switch rows and the
  // exposed API surfaces; hosts, overview, accounts, setup, messaging and the
  // runner card all render per-engine state that the switch suspends.
  "engine.state.changed": [
    ["settings"],
    ["hosts"],
    ["overview"],
    ["accounts"],
    ["setup"],
    ["agent-messaging"],
    ["runner"],
  ],

  // Agent portal controls live under Settings.
  "agent_portal.state": [["agent-portal"]],
  // Live agent sessions. This is the ONLY event the sessions view gets: nothing
  // publishes on register, heartbeat or event append, so the list polls and the
  // timeline streams over SSE instead. Force-close is broadcast because it ends
  // an agent every other console is also looking at.
  "agent_portal.session.force_closed": [["agent-sessions"]],

  // Agent Messaging state, address discovery, relays and delivery lifecycle.
  "schedules.recovery.warning": [["schedules"]],
  "schedules.changed": [["schedules"], ["watchdogs"]],
  "watchdogs.changed": [["watchdogs"], ["agent-messaging"], ["agent-portal"]],
  "agent_messaging.state.changed": [["agent-messaging"]],
  "agent_messaging.host.changed": [["agent-messaging"], ["hosts"]],
  "agent_messaging.address.changed": [["agent-messaging"]],
  "agent_messaging.conversation.changed": [["agent-messaging"]],
  "agent_messaging.conference.changed": [["agent-messaging"]],
  "agent_messaging.groups.changed": [["agent-messaging"]],
  "agent_messaging.subscriptions.changed": [["agent-messaging"]],
  "agent_messaging.message.changed": [["agent-messaging"], ["schedules"]],
  "agent_messaging.relay.changed": [["agent-messaging"]],
  "agent_messaging.queue.changed": [["agent-messaging"]],

  // Git Director
  "git_director.changed": [["git-director"]],
  "git_director.module_toggled": [["git-director"]],
  "git_director.commit_settings_updated": [["settings"], ["agents"]],
  "git_director.decision_forced": [["git-director"]],
  "git_director.worktree_evicted": [["git-director"]],

  // File transfer. The pool listing and the module state are separate queries,
  // so both are invalidated: a toggle changes the state card, an upload changes
  // the table, and a limits change moves the quota meter on the same page.
  "transfers.changed": [["transfers"]],
  "transfers.module_toggled": [["transfers"]],
  "transfers.limits_changed": [["transfers"]],
  "transfers.deleted": [["transfers"]],

  // Usage / dashboard
  "chatgpt.usage.updated": [["usage", "chatgpt"]],
  // Pushed by the clx wrapper via POST /claude/usage/report, not fetched by
  // the server — see api/src/services/claude-usage.ts.
  "claude.usage.updated": [["usage", "claude"]],
  // Also carries the fleet-window open/close, which restamps or clears every
  // insecure host row -- so the hosts list has to refresh, not just the summary.
  "insecure.approval.changed": [["host-daemons"],
    ["overview"],
    ["overview", "insecure-approvals"],
    ["insecure-approvals"],
    ["hosts"],
    ["hosts", "insecure"],
  ],

  // Account
  "passkey.registered": [["passkeys"]],
  "passkey.deleted": [["passkeys"]],

  // Hosts: insecure window state
  "insecure.requested": [
    ["overview"],
    ["overview", "insecure-approvals"],
    ["insecure-approvals"],
    ["hosts", "insecure"],
  ],
  "insecure.approved": [
    ["overview"],
    ["overview", "insecure-approvals"],
    ["insecure-approvals"],
    ["hosts"],
    ["hosts", "insecure"],
  ],
  "insecure.denied": [
    ["overview"],
    ["overview", "insecure-approvals"],
    ["insecure-approvals"],
  ],
  "insecure.domain.allowed": [
    ["overview"],
    ["overview", "insecure-approvals"],
    ["insecure-approvals"],
    ["hosts"],
    ["hosts", "insecure"],
  ],
  "insecure.domain.revoked": [["hosts"], ["hosts", "insecure"]],
};

/** WS event types whose payload contains a `slug` we use to scope invalidation. */
const PROJECT_SCOPED_EVENTS = new Set<string>([
  "project.changed",
  "project.updated",
  "project.created",
  "project.deleted",
  "project.note.created",
  "project.note.updated",
  "project.note.deleted",
  "project.todo.created",
  "project.todo.updated",
  "project.todo.deleted",
  "project.file.upserted",
  "project.file.updated",
  "project.file.deleted",
  "project.feedback.created",
  "project.feedback.updated",
  "project.archived",
  "project.unarchived",
  // Project memories are the long-standing gap here: `project.memory.*` is in
  // DEFAULT_INVALIDATIONS but was never project-scoped, so an agent writing one
  // refreshed the project list and left an open Activity tab stale.
  "project.memory.created",
  "project.memory.updated",
  "project.memory.deleted",
  "project.card.created",
  "project.card.updated",
  "project.card.moved",
  "project.card.claimed",
  "project.card.released",
  "project.card.deleted",
  "project.board.updated",
]);

function projectDetailSubKey(eventType: string): string | null {
  if (eventType.startsWith("project.note")) return "notes";
  if (eventType.startsWith("project.todo")) return "todos";
  if (eventType.startsWith("project.file")) return "files";
  if (eventType.startsWith("project.feedback")) return "feedback";
  if (eventType.startsWith("project.memory")) return "memories";
  if (eventType.startsWith("project.card") || eventType.startsWith("project.board")) return "board";
  return null;
}

function extractProjectSlug(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const slug = p.slug ?? p.project ?? (p.project_slug as unknown);
  return typeof slug === "string" && slug.length > 0 ? slug : null;
}

interface ToastPayload {
  message: string;
  title: string | null;
  level: "info" | "success" | "warn" | "error";
  timeoutMs: number | null;
}

function extractToastPayload(payload: unknown): ToastPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.message !== "string" || p.message.length === 0) return null;
  const level = p.level === "success" || p.level === "warn" || p.level === "error" ? p.level : "info";
  const title = typeof p.title === "string" && p.title.length > 0 ? p.title : null;
  const timeoutMs = typeof p.timeout_ms === "number" ? p.timeout_ms : null;
  return { message: p.message, title, level, timeoutMs };
}

/** Push a server-initiated `toast` WS event to the sonner Toaster. */
function showServerToast(payload: unknown): void {
  const parsed = extractToastPayload(payload);
  if (!parsed) return;
  // `title` (if present) is a short heading shown as the toast's primary
  // line, with the longer `message` as the description underneath; when no
  // title was sent, `message` alone is the primary line.
  const primary = parsed.title ?? parsed.message;
  const options = {
    description: parsed.title ? parsed.message : undefined,
    duration: parsed.timeoutMs ?? undefined,
  };
  if (parsed.level === "success") toast.success(primary, options);
  else if (parsed.level === "warn") toast.warning(primary, options);
  else if (parsed.level === "error") toast.error(primary, options);
  else toast.info(primary, options);
}

/**
 * Coalescing window for WebSocket-driven invalidations.
 *
 * Fleet traffic publishes bursts (relay heartbeats, communicator and session
 * changes) faster than heavy views such as `/admin/topology` can answer. A
 * plain `invalidateQueries` cancels the in-flight fetch and starts another, so
 * under a steady stream the query never completes while the API computes every
 * aborted request. Keys are therefore collected for a short window, flushed
 * once, and a key whose query is still fetching waits for that fetch instead
 * of aborting it, then gets exactly one trailing refresh.
 */
export const INVALIDATION_COALESCE_MS = 750;

export interface CoalescingInvalidator {
  invalidate(key: QueryKey): void;
  dispose(): void;
}

export function createCoalescingInvalidator(qc: QueryClient, windowMs: number): CoalescingInvalidator {
  const pending = new Map<string, QueryKey>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const schedule = () => {
    if (timer === null && !disposed) timer = setTimeout(flush, windowMs);
  };

  function flush(): void {
    timer = null;
    const keys = [...pending.entries()];
    pending.clear();
    for (const [hash, key] of keys) {
      if (qc.isFetching({ queryKey: key }) > 0) {
        // Let the running fetch finish; refresh once more afterwards.
        pending.set(hash, key);
        continue;
      }
      void qc.invalidateQueries({ queryKey: key }, { cancelRefetch: false });
    }
    if (pending.size > 0) schedule();
  }

  return {
    invalidate(key) {
      if (disposed) return;
      if (windowMs <= 0) {
        void qc.invalidateQueries({ queryKey: key }, { cancelRefetch: false });
        return;
      }
      pending.set(JSON.stringify(key), key);
      schedule();
    },
    dispose() {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending.clear();
    },
  };
}

/**
 * Subscribe the supplied WebSocket event stream to the query client.
 * Returns an unsubscribe function.
 */
export function wireWsToQueryClient(
  qc: QueryClient,
  events: Readable<WsEvent | null>,
  invalidations: WsInvalidationMap = DEFAULT_INVALIDATIONS,
  coalesceMs: number = INVALIDATION_COALESCE_MS,
): () => void {
  const invalidator = createCoalescingInvalidator(qc, coalesceMs);
  const unsubscribe = events.subscribe((event) => {
    if (!event || !event.type) return;
    if (event.type === "toast") {
      showServerToast(event.payload);
      return;
    }
    const keys = invalidations[event.type];
    if (keys && keys.length > 0) {
      for (const key of keys) {
        invalidator.invalidate(key);
      }
    }
    if (PROJECT_SCOPED_EVENTS.has(event.type)) {
      const slug = extractProjectSlug(event.payload);
      if (slug) {
        const subKey = projectDetailSubKey(event.type);
        if (subKey) {
          invalidator.invalidate(["project", slug, subKey]);
          invalidator.invalidate(["project", slug, "changes"]);
        } else {
          invalidator.invalidate(["project", slug]);
        }
      }
      invalidator.invalidate(["projects"]);
    }
  });
  return () => {
    unsubscribe();
    invalidator.dispose();
  };
}
