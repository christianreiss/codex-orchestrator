import { Collapsible as CollapsiblePrimitive } from "bits-ui";
import Content from "./collapsible-content.svelte";

const Root = CollapsiblePrimitive.Root;
const Trigger = CollapsiblePrimitive.Trigger;

export {
  Root,
  Trigger,
  Content,
  Root as Collapsible,
  Trigger as CollapsibleTrigger,
  Content as CollapsibleContent,
};
