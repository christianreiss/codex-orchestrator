import type { Node } from "@xyflow/svelte";
import type { MemoryGraphNode } from "$lib/api/memories";

export interface AtlasNodeData extends Record<string, unknown> {
  memory: MemoryGraphNode;
  displayKey: string;
  onSelect: (node: MemoryGraphNode) => void;
}

export type AtlasFlowNode = Node<AtlasNodeData, "atlas">;

export const MEMORY_NODE_WIDTH = 248;
export const MEMORY_NODE_HEIGHT = 118;
export const RELATION_NODE_WIDTH = 184;
export const RELATION_NODE_HEIGHT = 68;

export function displayMemoryKey(node: MemoryGraphNode): string {
  return node.memory_id ?? node.key ?? node.title ?? node.label ?? node.id;
}

export function formatCharacters(value: number): string {
  return `${Math.max(0, value).toLocaleString()} chars`;
}
