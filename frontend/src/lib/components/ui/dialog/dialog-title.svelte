<script lang="ts">
  import { Dialog as DialogPrimitive } from "bits-ui";
  import { cn } from "$lib/utils/cn";

  type Props = DialogPrimitive.TitleProps;
  let { class: className, ...rest }: Props = $props();
</script>

<DialogPrimitive.Title
  class={cn("text-h2", className)}
  {...rest}
/>
