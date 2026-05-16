import { Select as SelectPrimitive } from "bits-ui";
import Trigger from "./select-trigger.svelte";
import Content from "./select-content.svelte";
import Item from "./select-item.svelte";

const Root = SelectPrimitive.Root;
const Value = SelectPrimitive.Value;
const Group = SelectPrimitive.Group;
const Portal = SelectPrimitive.Portal;
const GroupHeading = SelectPrimitive.GroupHeading;

export {
  Root,
  Value,
  Group,
  GroupHeading,
  Portal,
  Trigger,
  Content,
  Item,
  Root as Select,
  Value as SelectValue,
  Trigger as SelectTrigger,
  Content as SelectContent,
  Item as SelectItem,
  Group as SelectGroup,
  GroupHeading as SelectLabel,
};
