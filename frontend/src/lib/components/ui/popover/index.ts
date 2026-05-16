import { Popover as PopoverPrimitive } from "bits-ui";
import Content from "./popover-content.svelte";

const Root = PopoverPrimitive.Root;
const Trigger = PopoverPrimitive.Trigger;
const Close = PopoverPrimitive.Close;
const Portal = PopoverPrimitive.Portal;

export {
  Root,
  Trigger,
  Close,
  Portal,
  Content,
  Root as Popover,
  Trigger as PopoverTrigger,
  Close as PopoverClose,
  Portal as PopoverPortal,
  Content as PopoverContent,
};
