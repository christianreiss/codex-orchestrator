<script lang="ts">
  import { onMount } from "svelte";
  import * as dagre from "@dagrejs/dagre";
  import {
    Background,
    BackgroundVariant,
    Controls,
    MarkerType,
    MiniMap,
    Panel,
    SvelteFlow,
    type Edge,
  } from "@xyflow/svelte";
  import "@xyflow/svelte/dist/style.css";
  import type { MemoryGraphEdge, MemoryGraphNode } from "$lib/api/memories";
  import { DEFAULT_NODE_COLOR, EDGE_COLORS, SCOPE_COLORS } from "$lib/constants/graph-palette";
  import MemoryGraphNodeComponent from "./MemoryGraphNode.svelte";
  import {
    MEMORY_NODE_HEIGHT,
    MEMORY_NODE_WIDTH,
    RELATION_NODE_HEIGHT,
    RELATION_NODE_WIDTH,
    displayMemoryKey,
    type AtlasFlowNode,
  } from "./atlas-types";

  type Props = {
    nodes: MemoryGraphNode[];
    edges: MemoryGraphEdge[];
    selectedNodeId?: string | null;
    showTags?: boolean;
    showProvenance?: boolean;
    onSelect: (node: MemoryGraphNode) => void;
  };

  let {
    nodes,
    edges,
    selectedNodeId = null,
    showTags = false,
    showProvenance = false,
    onSelect,
  }: Props = $props();

  const nodeTypes = { atlas: MemoryGraphNodeComponent };
  const MAX_LAYOUT_EDGES = 750;
  const MAX_LAYOUT_ELEMENTS = 1_100;
  let reducedMotion = $state(true);

  onMount(() => {
    reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });

  function edgeIsVisible(edge: MemoryGraphEdge): boolean {
    if (edge.type === "tagged_with") return showTags;
    if (edge.type === "written_by" || edge.type === "from_engine") return showProvenance;
    return true;
  }

  function nodeIsVisible(node: MemoryGraphNode, visibleEdges: MemoryGraphEdge[]): boolean {
    if (node.kind === "tag") return showTags;
    if (node.kind === "engine") return showProvenance;
    if (node.kind === "memory") return true;
    return visibleEdges.some((edge) => edge.source === node.id || edge.target === node.id);
  }

  function edgeColor(type: MemoryGraphEdge["type"]): string {
    return EDGE_COLORS[type];
  }

  function layoutGraph(rawNodes: MemoryGraphNode[], rawEdges: MemoryGraphEdge[]): {
    nodes: AtlasFlowNode[];
    edges: Edge[];
    tooDense: boolean;
    visibleNodeCount: number;
    visibleEdgeCount: number;
  } {
    const visibleEdges = rawEdges.filter(edgeIsVisible);
    const visibleNodes = rawNodes.filter((node) => nodeIsVisible(node, visibleEdges));
    const ids = new Set(visibleNodes.map((node) => node.id));
    const completeEdges = visibleEdges.filter((edge) => ids.has(edge.source) && ids.has(edge.target));

    if (
      completeEdges.length > MAX_LAYOUT_EDGES
      || visibleNodes.length + completeEdges.length > MAX_LAYOUT_ELEMENTS
    ) {
      return {
        nodes: [],
        edges: [],
        tooDense: true,
        visibleNodeCount: visibleNodes.length,
        visibleEdgeCount: completeEdges.length,
      };
    }

    const graph = new dagre.graphlib.Graph();
    graph.setGraph({
      rankdir: "LR",
      ranker: "tight-tree",
      nodesep: 34,
      edgesep: 20,
      ranksep: 86,
      marginx: 28,
      marginy: 28,
    });
    graph.setDefaultEdgeLabel(() => ({}));

    for (const node of [...visibleNodes].sort((a, b) => a.id.localeCompare(b.id))) {
      const memory = node.kind === "memory";
      graph.setNode(node.id, {
        width: memory ? MEMORY_NODE_WIDTH : RELATION_NODE_WIDTH,
        height: memory ? MEMORY_NODE_HEIGHT : RELATION_NODE_HEIGHT,
      });
    }
    for (const edge of [...completeEdges].sort((a, b) => a.id.localeCompare(b.id))) {
      graph.setEdge(edge.source, edge.target, { weight: edge.type === "in_scope" ? 2 : 1 });
    }
    dagre.layout(graph);

    return {
      nodes: visibleNodes.map((node) => {
        const size = node.kind === "memory"
          ? { width: MEMORY_NODE_WIDTH, height: MEMORY_NODE_HEIGHT }
          : { width: RELATION_NODE_WIDTH, height: RELATION_NODE_HEIGHT };
        const point = graph.node(node.id) as { x: number; y: number } | undefined;
        return {
          id: node.id,
          type: "atlas",
          position: {
            x: (point?.x ?? 0) - size.width / 2,
            y: (point?.y ?? 0) - size.height / 2,
          },
          width: size.width,
          height: size.height,
          style: `width: ${size.width}px; height: ${size.height}px;`,
          data: { memory: node, displayKey: displayMemoryKey(node), onSelect },
          selected: false,
          draggable: false,
          selectable: false,
          focusable: false,
          ariaLabel: `${node.kind} ${node.label}`,
          ariaRole: "group",
        } satisfies AtlasFlowNode;
      }),
      edges: completeEdges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: "smoothstep",
        animated: !reducedMotion && (edge.type === "written_by" || edge.type === "from_engine"),
        selectable: false,
        focusable: false,
        markerEnd: { type: MarkerType.ArrowClosed, color: edgeColor(edge.type), width: 14, height: 14 },
        style: `stroke: ${edgeColor(edge.type)}; stroke-width: 1.45; stroke-opacity: 0.58;`,
        ariaLabel: edge.type.replace(/_/g, " "),
      })),
      tooDense: false,
      visibleNodeCount: visibleNodes.length,
      visibleEdgeCount: completeEdges.length,
    };
  }

  const layouted = $derived(layoutGraph(nodes, edges));
  const flowNodes = $derived(
    layouted.nodes.map((node) => ({
      ...node,
      data: { ...node.data, onSelect },
      selected: node.id === selectedNodeId,
    })),
  );
</script>

<div class="memory-flow h-[560px] w-full overflow-hidden border-t bg-muted/20 md:h-[640px]">
  {#if layouted.tooDense}
    <div class="grid min-h-[520px] place-items-center p-8 text-center">
      <div class="max-w-md rounded-md border border-warning/25 bg-background p-5">
        <p class="font-semibold text-foreground">This relationship layer is too dense to map safely</p>
        <p class="mt-2 text-sm text-muted-foreground">
          {layouted.visibleNodeCount.toLocaleString()} nodes and {layouted.visibleEdgeCount.toLocaleString()} edges would block the browser. Turn off Tags or Provenance, or narrow the filters. The list view still contains every loaded memory.
        </p>
      </div>
    </div>
  {:else}
    <SvelteFlow
      nodes={flowNodes}
      edges={layouted.edges}
      {nodeTypes}
      fitView
      fitViewOptions={{ padding: 0.18, minZoom: 0.18, maxZoom: 1.15, duration: reducedMotion ? 0 : 350 }}
      minZoom={0.12}
      maxZoom={1.8}
      nodesDraggable={false}
      nodesConnectable={false}
      deleteKey={null}
      selectionKey={null}
      multiSelectionKey={null}
      panOnScroll
      zoomOnScroll={false}
      zoomOnPinch
      onlyRenderVisibleElements
    >
      <Background variant={BackgroundVariant.Dots} gap={24} size={1.25} patternColor="hsl(var(--muted-foreground) / 0.22)" />
      <Controls position="bottom-left" showLock={false} fitViewOptions={{ padding: 0.18, duration: reducedMotion ? 0 : 300 }} />
      {#if layouted.nodes.length <= 250}
        <MiniMap
          position="bottom-right"
          pannable
          zoomable
          nodeColor={(node) => {
            const scope = (node.data as { memory?: MemoryGraphNode })?.memory?.scope;
            return scope ? SCOPE_COLORS[scope] : DEFAULT_NODE_COLOR;
          }}
          maskColor="hsl(var(--background) / 0.72)"
        />
      {/if}
      <Panel position="top-left" class="!m-3">
        <div class="rounded-md border border-border/70 bg-background px-3 py-2 text-[10px] text-muted-foreground">
          <p class="font-semibold text-foreground">Memory topology</p>
          <p>Pan to explore · scroll to move · use controls to zoom</p>
        </div>
      </Panel>
    </SvelteFlow>
  {/if}
</div>

<style>
  :global(.memory-flow .svelte-flow__node) {
    border: 0;
    background: transparent;
    box-shadow: none;
  }

  :global(.memory-flow .svelte-flow__node:focus-visible) {
    outline: 2px solid hsl(var(--ring));
    outline-offset: 4px;
    border-radius: var(--radius);
  }

  :global(.memory-flow .svelte-flow__controls),
  :global(.memory-flow .svelte-flow__minimap) {
    overflow: hidden;
    border: 1px solid hsl(var(--border) / 0.75);
    border-radius: var(--radius);
    background: hsl(var(--background));
  }

  :global(.memory-flow .svelte-flow__controls-button) {
    border-color: hsl(var(--border) / 0.65);
    background: transparent;
    color: hsl(var(--foreground));
  }

  @media (prefers-reduced-motion: reduce) {
    :global(.memory-flow .svelte-flow__edge-path) {
      animation: none !important;
    }
  }
</style>
