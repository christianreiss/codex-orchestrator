<script lang="ts">
  import { cn } from "$lib/utils/cn";

  type Props = {
    role: string | null | undefined;
    label?: string;
    class?: string;
  };
  let { role, label, class: className }: Props = $props();

  /**
   * Color-coded per spec: owner = solid primary (apex role, emphasis not
   * hue -- the warm repaint leaves too little hue distance between accent
   * and warning to tell them apart, see below), admin = destructive,
   * viewer = slate, fleet_operator = warning, trusted_user = info,
   * user = gray. Falls back to gray for unknown roles.
   *
   * viewer/user stay on raw slate/gray: they're neutral grays outside the
   * indigo/violet -> terracotta/amber repaint, not a status signal, so
   * there's no semantic token for them to move to.
   */
  function variantClasses(r: string | null | undefined): string {
    switch ((r ?? "").toLowerCase()) {
      case "owner":
        return "border-transparent bg-primary text-primary-foreground";
      case "admin":
        return "border-destructive/25 bg-destructive-muted text-destructive-muted-foreground";
      case "fleet_operator":
        return "border-warning/25 bg-warning-muted text-warning-muted-foreground";
      case "trusted_user":
        return "border-info/25 bg-info-muted text-info-muted-foreground";
      case "viewer":
        return "border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-900/40 dark:text-slate-300";
      case "user":
      default:
        return "border-gray-200 bg-gray-50 text-gray-700 dark:border-gray-700 dark:bg-gray-900/40 dark:text-gray-300";
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

<span
  class={cn(
    "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium",
    variantClasses(role),
    className,
  )}
>
  {displayLabel}
</span>
