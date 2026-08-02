import Root from "./badge.svelte";
import { tv, type VariantProps } from "tailwind-variants";

export const badgeVariants = tv({
  base: "inline-flex min-h-5 items-center rounded-md border px-2.5 py-0.5 text-[11px] font-semibold tracking-[0.01em] transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  variants: {
    variant: {
      default: "border-transparent bg-primary text-primary-foreground hover:bg-primary/80",
      secondary: "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
      destructive: "border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/80",
      outline: "text-foreground",
      success: "border-success/25 bg-success-muted text-success-muted-foreground hover:bg-success-muted/80",
      warning: "border-warning/25 bg-warning-muted text-warning-muted-foreground hover:bg-warning-muted/80",
      info: "border-info/25 bg-info-muted text-info-muted-foreground hover:bg-info-muted/80",
    },
  },
  defaultVariants: { variant: "default" },
});

export type BadgeVariant = VariantProps<typeof badgeVariants>["variant"];
export { Root, Root as Badge };
