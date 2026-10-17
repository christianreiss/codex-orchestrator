import type { AgentAddress } from "$lib/api/agentMessaging";
import type { BadgeVariant } from "$lib/components/ui/badge";

export function routeLabel(address: AgentAddress | undefined | null): string {
  if (!address) return "unknown";
  return address.name ?? address.alias ?? address.address;
}

/** Delivery status colour: trouble is red, in flight is amber, the rest is quiet. */
export function statusVariant(status: string): BadgeVariant {
  if (status === "dead" || status === "ambiguous") return "destructive";
  if (status === "leased" || status === "accepted") return "warning";
  if (status === "completed") return "success";
  return "secondary";
}
