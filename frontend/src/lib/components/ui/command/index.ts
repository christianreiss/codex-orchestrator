import { Command as CommandPrimitive } from "bits-ui";
import Root from "./command.svelte";
import Input from "./command-input.svelte";
import List from "./command-list.svelte";
import Item from "./command-item.svelte";
import Group from "./command-group.svelte";
import Empty from "./command-empty.svelte";
import Separator from "./command-separator.svelte";

const LinkItem = CommandPrimitive.LinkItem;
const Loading = CommandPrimitive.Loading;

export {
  Root,
  Input,
  List,
  Item,
  Group,
  Empty,
  Separator,
  LinkItem,
  Loading,
  Root as Command,
  Input as CommandInput,
  List as CommandList,
  Item as CommandItem,
  Group as CommandGroup,
  Empty as CommandEmpty,
  Separator as CommandSeparator,
  LinkItem as CommandLinkItem,
  Loading as CommandLoading,
};
