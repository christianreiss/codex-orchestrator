import Root from "./alert.svelte";
import Title from "./alert-title.svelte";
import Description from "./alert-description.svelte";
import { tv, type VariantProps } from "tailwind-variants";

export const alertVariants = tv({
  base: "relative w-full rounded-xl border p-4 shadow-hairline [&>svg~*]:pl-7 [&>svg+div]:translate-y-[-3px] [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-4 [&>svg]:text-foreground",
  variants: {
    variant: {
      default: "bg-background text-foreground",
      destructive:
        "border-destructive/25 bg-destructive-muted text-destructive-muted-foreground [&>svg]:text-destructive",
      warning: "border-warning/25 bg-warning-muted text-warning-muted-foreground [&>svg]:text-warning",
      info: "border-info/25 bg-info-muted text-info-muted-foreground [&>svg]:text-info",
    },
  },
  defaultVariants: { variant: "default" },
});

export type AlertVariant = VariantProps<typeof alertVariants>["variant"];
export {
  Root,
  Title,
  Description,
  Root as Alert,
  Title as AlertTitle,
  Description as AlertDescription,
};
