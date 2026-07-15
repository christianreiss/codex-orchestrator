import { Dialog as SheetPrimitive } from "bits-ui";
import { tv, type VariantProps } from "tailwind-variants";
import Overlay from "./sheet-overlay.svelte";
import Content from "./sheet-content.svelte";
import Header from "./sheet-header.svelte";
import Footer from "./sheet-footer.svelte";
import Title from "./sheet-title.svelte";
import Description from "./sheet-description.svelte";

const Root = SheetPrimitive.Root;
const Trigger = SheetPrimitive.Trigger;
const Close = SheetPrimitive.Close;
const Portal = SheetPrimitive.Portal;

export const sheetVariants = tv({
  base: "fixed z-50 gap-4 bg-background p-6 shadow-[0_24px_80px_rgba(15,23,42,0.24)] transition ease-out data-[state=closed]:duration-200 data-[state=open]:duration-300 data-[state=open]:animate-in data-[state=closed]:animate-out",
  variants: {
    side: {
      top: "inset-x-0 top-0 border-b data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top",
      bottom:
        "inset-x-0 bottom-0 border-t data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom",
      left: "inset-y-0 left-0 h-full w-3/4 border-r data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left sm:max-w-sm",
      right:
        "inset-y-0 right-0 h-full w-3/4 border-l data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right sm:max-w-sm",
    },
  },
  defaultVariants: { side: "right" },
});

export type SheetSide = VariantProps<typeof sheetVariants>["side"];

export {
  Root,
  Trigger,
  Close,
  Portal,
  Overlay,
  Content,
  Header,
  Footer,
  Title,
  Description,
  //
  Root as Sheet,
  Trigger as SheetTrigger,
  Close as SheetClose,
  Portal as SheetPortal,
  Overlay as SheetOverlay,
  Content as SheetContent,
  Header as SheetHeader,
  Footer as SheetFooter,
  Title as SheetTitle,
  Description as SheetDescription,
};
