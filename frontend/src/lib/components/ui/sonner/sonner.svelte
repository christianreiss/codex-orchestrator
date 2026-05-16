<script lang="ts">
  import { Toaster as Sonner, type ToasterProps } from "svelte-sonner";

  type Props = ToasterProps;
  let { ...rest }: Props = $props();
</script>

<Sonner
  theme="system"
  class="toaster group"
  toastOptions={{
    classes: {
      toast:
        "group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
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
