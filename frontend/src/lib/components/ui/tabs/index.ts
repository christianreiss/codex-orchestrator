import { Tabs as TabsPrimitive } from "bits-ui";
import List from "./tabs-list.svelte";
import Trigger from "./tabs-trigger.svelte";
import Content from "./tabs-content.svelte";

const Root = TabsPrimitive.Root;

export { Root, List, Trigger, Content, Root as Tabs, List as TabsList, Trigger as TabsTrigger, Content as TabsContent };
