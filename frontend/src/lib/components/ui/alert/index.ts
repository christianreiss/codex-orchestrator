import Root from "./alert.svelte";
import Title from "./alert-title.svelte";
import Description from "./alert-description.svelte";
import { tv, type VariantProps } from "tailwind-variants";

export const alertVariants = tv({
  base: "relative w-full rounded-xl border p-4 shadow-sm [&>svg~*]:pl-7 [&>svg+div]:translate-y-[-3px] [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-4 [&>svg]:text-foreground",
  variants: {
    variant: {
      default: "bg-background text-foreground",
      destructive: "border-destructive/35 bg-destructive/5 text-destructive [&>svg]:text-destructive",
      warning: "border-amber-500/35 bg-amber-500/7 text-amber-700 dark:text-amber-300 [&>svg]:text-amber-500",
      info: "border-blue-500/35 bg-blue-500/7 text-blue-700 dark:text-blue-300 [&>svg]:text-blue-500",
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
