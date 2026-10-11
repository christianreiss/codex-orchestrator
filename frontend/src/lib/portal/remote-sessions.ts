import type { AgentSessionRow } from "../api/agentSessions";
import type { DaemonHost, RemoteSession } from "../api/hostDaemons";
import type { Presence } from "./types";

export function remoteForAgent(agent: AgentSessionRow | undefined, sessions: RemoteSession[]) {
  if (!agent) return undefined;
  return sessions.find(remote => remote.sessionId === agent.id ||
    (remote.addressId && agent.work.address === `agent:${remote.addressId}`));
}

export function remoteState(status: string): { label: string; detail: string; presence: Presence } {
  switch (status) {
    case "queued": return { label: "Queued", detail: "Waiting for the host to accept the start request.", presence: "idle" };
    case "running": return { label: "Running", detail: "The remote process is running. Its conversation appears when registered.", presence: "working" };
    case "idle": return { label: "Ready to continue", detail: "Send a new instruction to continue this conversation.", presence: "idle" };
    case "waiting": return { label: "Waiting for input", detail: "The session is waiting for your next instruction.", presence: "idle" };
    case "stopping": return { label: "Stopping", detail: "The host has been asked to stop this session.", presence: "working" };
    case "closed": return { label: "Ended", detail: "The process has ended. You can continue if its native transcript is still available.", presence: "ended" };
    case "failed": return { label: "Failed", detail: "The last operation failed. Check its details before continuing.", presence: "offline" };
    default: return { label: "Outcome unknown", detail: "The result has not been confirmed. Check the host before starting more work.", presence: "offline" };
  }
}

export function hostBlockReason(host: DaemonHost | undefined): string {
  if (!host) return "Choose a host.";
  if (!host.enabled || host.deadline_expired) return "Remote starts are disabled on this host.";
  if (host.access?.allowed === false) return "Host access is closed. Enable access on the host page.";
  if (host.health.state === "red" || host.health.state === "disabled") return "The host is unavailable. Check its connection on the host page.";
  return "";
}

export function continuationBlockReason(session: RemoteSession, host: DaemonHost | undefined): string {
  const blocked = hostBlockReason(host);
  if (blocked) return blocked;
  if (["queued", "running", "stopping"].includes(session.status)) return remoteState(session.status).detail;
  if (!["idle", "waiting", "closed", "failed"].includes(session.status)) return remoteState(session.status).detail;
  if (!session.addressId) return "No native transcript is available to continue. Start a new session.";
  return "";
}
