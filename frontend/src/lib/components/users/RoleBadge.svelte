<script lang="ts">
  import { Badge, type BadgeVariant } from "$lib/components/ui/badge";

  type Props = {
    role: string | null | undefined;
    label?: string;
    class?: string;
  };
  let { role, label, class: className }: Props = $props();

  /**
   * Shared Badge variants only (DESIGN.md VIS-1/VIS-4): owner is the solid
   * primary badge (apex role, emphasis not hue), admin the soft destructive,
   * fleet_operator warning, trusted_user info. viewer and user are neutral
   * (secondary/outline), as is any unknown role. The label always names the
   * role, so color is never the only cue.
   */
  function variantFor(r: string | null | undefined): BadgeVariant {
    switch ((r ?? "").toLowerCase()) {
      case "owner":
        return "default";
      case "admin":
        return "danger";
      case "fleet_operator":
        return "warning";
      case "trusted_user":
        return "info";
      case "viewer":
        return "secondary";
      default:
        return "outline";
    }
  }

  const DEFAULT_LABELS: Record<string, string> = {
    owner: "Owner",
    admin: "Admin",
    viewer: "Viewer",
    fleet_operator: "Fleet Operator",
    trusted_user: "Trusted User",
    user: "User",
  };

  const displayLabel = $derived(label ?? DEFAULT_LABELS[(role ?? "").toLowerCase()] ?? role ?? "Unknown");
</script>

<Badge variant={variantFor(role)} class={className}>{displayLabel}</Badge>
