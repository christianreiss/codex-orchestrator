<script lang="ts">
  import { Toaster as Sonner, type ToasterProps } from "svelte-sonner";
  import { mode } from "mode-watcher";

  type Props = ToasterProps;
  let { ...rest }: Props = $props();
</script>

<Sonner
  theme={mode.current ?? "system"}
  class="toaster group"
  style="
    --success-bg: hsl(var(--success-muted));
    --success-border: hsl(var(--success));
    --success-text: hsl(var(--success-muted-foreground));
    --info-bg: hsl(var(--info-muted));
    --info-border: hsl(var(--info));
    --info-text: hsl(var(--info-muted-foreground));
    --warning-bg: hsl(var(--warning-muted));
    --warning-border: hsl(var(--warning));
    --warning-text: hsl(var(--warning-muted-foreground));
    --error-bg: hsl(var(--destructive-muted));
    --error-border: hsl(var(--destructive));
    --error-text: hsl(var(--destructive-muted-foreground));
  "
  toastOptions={{
    classes: {
      toast:
        "group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:rounded-lg group-[.toaster]:shadow-pop",
      description: "group-[.toast]:text-muted-foreground",
      actionButton: "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
      cancelButton: "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
    },
  }}
  richColors
  closeButton
  position="top-right"
  {...rest}
/>
