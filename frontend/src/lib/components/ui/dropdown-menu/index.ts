import { DropdownMenu as DropdownMenuPrimitive } from "bits-ui";
import RadioItem from "./dropdown-menu-radio-item.svelte";
import Content from "./dropdown-menu-content.svelte";
import Item from "./dropdown-menu-item.svelte";
import Separator from "./dropdown-menu-separator.svelte";
import Label from "./dropdown-menu-label.svelte";

const Root = DropdownMenuPrimitive.Root;
const Trigger = DropdownMenuPrimitive.Trigger;
const RadioGroup = DropdownMenuPrimitive.RadioGroup;
const Group = DropdownMenuPrimitive.Group;
const Portal = DropdownMenuPrimitive.Portal;

export {
  RadioGroup,
  RadioItem,
  Root,
  Trigger,
  Group,
  Portal,
  Content,
  Item,
  Separator,
  Label,
  //
  Root as DropdownMenu,
  Trigger as DropdownMenuTrigger,
  Group as DropdownMenuGroup,
  Portal as DropdownMenuPortal,
  Content as DropdownMenuContent,
  Item as DropdownMenuItem,
  Separator as DropdownMenuSeparator,
  Label as DropdownMenuLabel,
};
