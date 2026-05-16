<script lang="ts">
  import { cn } from "$lib/utils/cn";

  type Props = {
    role: string | null | undefined;
    label?: string;
    class?: string;
  };
  let { role, label, class: className }: Props = $props();

  /**
   * Color-coded per spec:
   * admin = red, fleet_operator = amber, trusted_user = blue, user = gray.
   * Falls back to gray for unknown roles.
   */
  function variantClasses(r: string | null | undefined): string {
    switch ((r ?? "").toLowerCase()) {
      case "admin":
        return "border-red-200 bg-red-50 text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300";
      case "fleet_operator":
        return "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-300";
      case "trusted_user":
        return "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900/50 dark:bg-blue-950/40 dark:text-blue-300";
      case "user":
      default:
        return "border-gray-200 bg-gray-50 text-gray-700 dark:border-gray-700 dark:bg-gray-900/40 dark:text-gray-300";
    }
  }

  const DEFAULT_LABELS: Record<string, string> = {
    admin: "Admin",
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
