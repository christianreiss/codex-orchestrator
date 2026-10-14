<script lang="ts">
  import { untrack } from "svelte";
  import ServerIcon from "@lucide/svelte/icons/server";
  import RadioTowerIcon from "@lucide/svelte/icons/radio-tower";
  import ZoomInIcon from "@lucide/svelte/icons/zoom-in";
  import ZoomOutIcon from "@lucide/svelte/icons/zoom-out";
  import MaximizeIcon from "@lucide/svelte/icons/maximize";
  import { ENGINE_META, isEngine } from "$lib/constants/engines";
  import { radialLayout, traversalOrder, SERVER_ID, polar, type PlacedNode } from "$lib/topology/layout";
  import { communicatorLabel, matchesQuery, nodeState, type GraphModel } from "$lib/topology/model";
  import type { TopologyAgent, TopologyCommunicator, TopologyServer } from "$lib/api/topology";

  type Props = {
    server: TopologyServer | undefined;
    model: GraphModel;
    selectedId: string | null;
    query?: string;
    onselect: (id: string | null) => void;
  };
  let { server, model, selectedId, query = "", onselect }: Props = $props();

  // ── geometry ────────────────────────────────────────────────────────────────
  // The model is rebuilt every second (ghosts fade on the clock); the layout only
  // when the shape of the tree changes, so nodes are not re-slotted for nothing.
  const structure = $derived(
    JSON.stringify([model.communicators.map((item) => item.node.id), model.agents.map((item) => [item.node.id, item.node.association.parent_id])]),
  );
  const layout = $derived.by(() => {
    void structure;
    return untrack(() =>
      radialLayout(
        model.communicators.map((item) => ({ id: item.node.id })),
        model.agents.map((item) => ({ id: item.node.id, parent: item.node.association.parent_id })),
      ),
    );
  });
  const order = $derived(traversalOrder(layout));

  let width = $state(800);
  let height = $state(600);
  let zoom = $state(1);
  let panX = $state(0);
  let panY = $state(0);
  const fit = $derived(Math.max(0.05, Math.min(width, height) / 2 / (layout.extent + 64)));
  const scale = $derived(fit * zoom);

  // ── motion: nodes glide to their slot; edges follow them ────────────────────
  let reduced = $state(false);
  let shown = $state<Record<string, { x: number; y: number }>>({});
  let frame = 0;
  $effect(() => {
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    reduced = query.matches;
    const listener = () => (reduced = query.matches);
    query.addEventListener("change", listener);
    return () => query.removeEventListener("change", listener);
  });
  $effect(() => {
    const nodes = layout.nodes;
    const skipMotion = reduced;
    untrack(() => {
      const next = { ...shown };
      for (const [id, node] of nodes) {
        if (next[id]) continue;
        // A new node grows out of whatever it hangs from.
        const parent = node.parent ? (next[node.parent] ?? nodes.get(node.parent)) : null;
        next[id] = skipMotion ? { x: node.x, y: node.y } : { x: parent?.x ?? 0, y: parent?.y ?? 0 };
      }
      for (const id of Object.keys(next)) if (!nodes.has(id)) delete next[id];
      shown = next;
      if (skipMotion) {
        const exact: Record<string, { x: number; y: number }> = {};
        for (const [id, node] of nodes) exact[id] = { x: node.x, y: node.y };
        shown = exact;
      } else if (!frame) frame = requestAnimationFrame(step);
    });
  });
  function step() {
    frame = 0;
    let moving = false;
    const next: Record<string, { x: number; y: number }> = {};
    for (const [id, target] of layout.nodes) {
      const current = shown[id] ?? { x: target.x, y: target.y };
      const dx = target.x - current.x;
      const dy = target.y - current.y;
      if (Math.abs(dx) < 0.3 && Math.abs(dy) < 0.3) {
        next[id] = { x: target.x, y: target.y };
      } else {
        next[id] = { x: current.x + dx * 0.18, y: current.y + dy * 0.18 };
        moving = true;
      }
    }
    shown = next;
    if (moving) frame = requestAnimationFrame(step);
  }
  $effect(() => () => frame && cancelAnimationFrame(frame));

  const at = (id: string) => shown[id] ?? layout.nodes.get(id) ?? { x: 0, y: 0 };

  function edgePath(from: PlacedNode, to: PlacedNode): string {
    const a = at(from.id);
    const b = at(to.id);
    if (from.kind === "server") return `M${a.x},${a.y} L${b.x},${b.y}`;
    const radiusTo = Math.hypot(b.x, b.y);
    const radiusFrom = Math.hypot(a.x, a.y);
    const angleFrom = Math.atan2(a.x, -a.y);
    const control = polar(radiusFrom + (radiusTo - radiusFrom) * 0.55, angleFrom);
    return `M${a.x},${a.y} Q${control.x},${control.y} ${b.x},${b.y}`;
  }

  // ── pan, zoom ───────────────────────────────────────────────────────────────
  let surface = $state<HTMLDivElement | null>(null);
  let drag: { x: number; y: number; panX: number; panY: number; moved: boolean } | null = null;
  function zoomAround(factor: number, cx = width / 2, cy = height / 2) {
    const next = Math.min(8, Math.max(0.25, zoom * factor));
    const k = next / zoom;
    // Keep the world point under (cx, cy) fixed.
    panX = cx - width / 2 - (cx - width / 2 - panX) * k;
    panY = cy - height / 2 - (cy - height / 2 - panY) * k;
    zoom = next;
  }
  function resetView() {
    zoom = 1;
    panX = 0;
    panY = 0;
  }
  $effect(() => {
    const el = surface;
    if (!el) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      zoomAround(Math.exp(-event.deltaY * 0.0015), event.clientX - rect.left, event.clientY - rect.top);
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  });
  let suppressClick = false;
  function pointerDown(event: PointerEvent) {
    if (event.button !== 0) return;
    drag = { x: event.clientX, y: event.clientY, panX, panY, moved: false };
  }
  function pointerMove(event: PointerEvent) {
    if (!drag) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved) {
      if (Math.hypot(dx, dy) < 5) return;
      drag.moved = true;
      // Capture only once it is a drag: capturing on press would retarget the
      // click that follows a plain tap on a node.
      surface?.setPointerCapture(event.pointerId);
    }
    panX = drag.panX + dx;
    panY = drag.panY + dy;
  }
  function pointerUp(event: PointerEvent) {
    const wasDrag = drag?.moved ?? false;
    drag = null;
    if (wasDrag) {
      surface?.releasePointerCapture?.(event.pointerId);
      suppressClick = true;
      setTimeout(() => (suppressClick = false), 0);
      return;
    }
    // A tap on empty canvas clears the selection.
    if ((event.target as Element).closest("[data-node], button") === null) onselect(null);
  }
  const choose = (id: string, selected: boolean) => {
    if (!suppressClick) onselect(selected ? null : id);
  };

  // ── keyboard ────────────────────────────────────────────────────────────────
  let hoverId = $state<string | null>(null);
  let focusId = $state<string | null>(null);
  const tabStop = $derived(selectedId && order.includes(selectedId) ? selectedId : (order[0] ?? null));
  function focusNode(id: string | undefined) {
    if (!id) return;
    surface?.querySelector<SVGGElement>(`[data-node="${CSS.escape(id)}"]`)?.focus();
  }
  function keydown(event: KeyboardEvent, id: string) {
    const index = order.indexOf(id);
    const parent = layout.nodes.get(id)?.parent ?? null;
    const first = order.find((candidate) => layout.nodes.get(candidate)?.parent === id);
    const handled = (fn: () => void) => {
      event.preventDefault();
      event.stopPropagation();
      fn();
    };
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        return handled(() => focusNode(order[Math.min(order.length - 1, index + 1)]));
      case "ArrowLeft":
      case "ArrowUp":
        return handled(() => focusNode(order[Math.max(0, index - 1)]));
      case "Home":
        return handled(() => focusNode(order[0]));
      case "End":
        return handled(() => focusNode(order[order.length - 1]));
      case "PageDown":
        return handled(() => focusNode(first));
      case "PageUp":
        return handled(() => focusNode(parent && parent !== SERVER_ID ? parent : undefined));
      case "Enter":
      case " ":
        return handled(() => onselect(id === selectedId ? null : id));
      case "Escape":
        return handled(() => onselect(null));
    }
  }
  function surfaceKey(event: KeyboardEvent) {
    if (event.key === "+" || event.key === "=") zoomAround(1.25);
    else if (event.key === "-" || event.key === "_") zoomAround(0.8);
    else if (event.key === "0") resetView();
  }

  // ── presentation helpers ────────────────────────────────────────────────────
  const engineColor = (engine: string) => (isEngine(engine) ? `hsl(var(--persona-${engine}))` : "hsl(var(--muted-foreground))");
  const engineCode = (engine: string) => (isEngine(engine) ? ENGINE_META[engine].avatar : "··");
  function presenceColor(presence: string): string {
    if (presence === "listening" || presence === "working") return "hsl(var(--success))";
    if (presence === "idle") return "hsl(var(--warning))";
    return "hsl(var(--muted-foreground))";
  }
  function healthColor(state: string): string {
    if (state === "closing") return "hsl(var(--destructive))";
    if (state === "stale" || state === "gone") return "hsl(var(--warning))";
    return "hsl(var(--success))";
  }
  /** With a selection, only the edges touching it stay at full strength. */
  const selectedParent = $derived(selectedId ? (layout.nodes.get(selectedId)?.parent ?? null) : null);
  const onPath = (childId: string, parentId: string) => childId === selectedId || parentId === selectedId || childId === selectedParent;
  const edgeFocus = (childId: string, parentId: string) => (selectedId === null || onPath(childId, parentId) ? 1 : 0.22);
  const edgeBoost = (childId: string, parentId: string) => (selectedId !== null && onPath(childId, parentId) ? 1 : 0);
  const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
  const dimmed = (id: string, node: TopologyAgent | TopologyCommunicator) => query.trim() !== "" && !matchesQuery(node, query) && id !== selectedId;
  // Labels crowd quickly: a big fleet shows them once zoomed in, and always for
  // the node being pointed at, selected, or found by the search box.
  const showAgentLabels = $derived(scale >= 1.25 || model.agents.length <= 24);
  /** Agent labels fan outward from the centre so neighbours on a row do not collide. */
  function labelAt(pos: { x: number; y: number }): { x: number; y: number; anchor: "start" | "middle" | "end" } {
    const r = Math.hypot(pos.x, pos.y);
    if (r < 1) return { x: 0, y: 30, anchor: "middle" };
    const ux = pos.x / r;
    const uy = pos.y / r;
    const anchor = ux > 0.3 ? "start" : ux < -0.3 ? "end" : "middle";
    return { x: ux * 22, y: uy * 22 + (anchor === "middle" ? (uy > 0 ? 9 : -2) : 4), anchor };
  }
  const flowing = $derived(model.agents.length <= 160);

  function describeCommunicator(item: (typeof model.communicators)[number]): string {
    const c = item.node;
    const kids = c.agent_ids.length;
    return `Communicator ${communicatorLabel(c)}, cxx ${c.version}, ${item.ghost ? "disconnected" : c.health}, ${kids} ${kids === 1 ? "agent" : "agents"}`;
  }
  function describeAgent(item: (typeof model.agents)[number]): string {
    const a = item.node;
    const where =
      a.association.state === "unattributed" ? "direct, no communicator" : a.association.state === "stale" ? "carried by a communicator, link quiet" : "carried by a communicator";
    return `Agent ${a.name}, ${a.engine}, ${item.ghost ? "ended" : a.presence}, ${where}`;
  }
</script>

<div
  bind:this={surface}
  bind:clientWidth={width}
  bind:clientHeight={height}
  class="topology-surface relative h-full min-h-[22rem] w-full touch-none select-none overflow-hidden rounded-lg border bg-card"
  role="presentation"
  onkeydown={surfaceKey}
  onpointerdown={pointerDown}
  onpointermove={pointerMove}
  onpointerup={pointerUp}
  onpointercancel={() => (drag = null)}
>
  <svg {width} {height} viewBox="0 0 {width} {height}" role="group" aria-label="Connection topology: server, communicators and agents" class="absolute inset-0 block">
    <defs>
      <radialGradient id="topo-server-glow">
        <stop offset="0%" stop-color="hsl(var(--primary))" stop-opacity="0.35" />
        <stop offset="100%" stop-color="hsl(var(--primary))" stop-opacity="0" />
      </radialGradient>
      <radialGradient id="topo-field" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="hsl(var(--primary))" stop-opacity="0.07" />
        <stop offset="100%" stop-color="hsl(var(--primary))" stop-opacity="0" />
      </radialGradient>
    </defs>
    <g transform="translate({width / 2 + panX} {height / 2 + panY}) scale({scale})">
      <circle r={layout.extent + 120} fill="url(#topo-field)" />

      <g aria-hidden="true">
        {#each layout.rings as radius (radius)}
          <circle r={radius} fill="none" stroke="hsl(var(--border))" stroke-width={1 / scale > 1.6 ? 1.6 : 1} stroke-dasharray="2 7" opacity="0.9" vector-effect="non-scaling-stroke" />
        {/each}
      </g>

      <g aria-hidden="true" fill="none">
        {#each model.communicators as item (item.node.id)}
          {@const placed = layout.nodes.get(item.node.id)}
          {#if placed && shown[item.node.id]}
            {@const state = nodeState(item.node, item.ghost !== null)}
            <path
              d={edgePath(layout.nodes.get(SERVER_ID)!, placed)}
              stroke={healthColor(state)}
              stroke-width={4 + edgeBoost(item.node.id, SERVER_ID)}
              stroke-linecap="round"
              stroke-dasharray={state === "live" ? undefined : "5 6"}
              opacity={(state === "live" ? 0.55 : 0.8) * item.strength * edgeFocus(item.node.id, SERVER_ID)}
              class:edge-flow={state === "live" && flowing && !reduced}
              vector-effect="non-scaling-stroke"
            />
          {/if}
        {/each}
        {#each model.agents as item (item.node.id)}
          {@const placed = layout.nodes.get(item.node.id)}
          {@const parent = placed?.parent ? layout.nodes.get(placed.parent) : undefined}
          {#if placed && parent && shown[item.node.id]}
            {@const link = item.node.association}
            {@const direct = link.state === "unattributed" || parent.id === SERVER_ID}
            <path
              d={edgePath(parent, placed)}
              stroke={direct ? "hsl(var(--muted-foreground))" : link.state === "stale" ? "hsl(var(--warning))" : "hsl(var(--success))"}
              stroke-width={(direct ? 2.5 : 3) + edgeBoost(item.node.id, parent.id)}
              stroke-linecap="round"
              stroke-dasharray={direct ? "1 6" : link.state === "stale" ? "4 5" : undefined}
              opacity={(direct ? 0.55 : 0.6) * item.strength * edgeFocus(item.node.id, parent.id)}
              class:edge-flow={!direct && link.state === "attributed" && flowing && !reduced && !item.ghost}
              vector-effect="non-scaling-stroke"
            />
          {/if}
        {/each}
      </g>

      <!-- server -->
      <g aria-hidden="true">
        <circle r="74" fill="url(#topo-server-glow)" />
        <circle r="38" fill="hsl(var(--card))" stroke="hsl(var(--primary))" stroke-width="2.5" />
        <circle r="30" fill="hsl(var(--primary) / 0.12)" />
        <ServerIcon x={-13} y={-13} size={26} class="text-primary" />
        {#if server}
          <text y="60" text-anchor="middle" class="node-label node-label--strong">{truncate(server.label, 28)}</text>
        {/if}
      </g>

      {#each model.communicators as item (item.node.id)}
        {@const id = item.node.id}
        {@const pos = at(id)}
        {@const state = nodeState(item.node, item.ghost !== null)}
        {@const selected = selectedId === id}
        {@const lit = selected || hoverId === id || focusId === id}
        <g
          data-node={id}
          class="node node--communicator"
          class:node--selected={selected}
          style:transform="translate({pos.x}px, {pos.y}px)"
          style:opacity={dimmed(id, item.node) ? 0.22 : item.strength}
          role="button"
          tabindex={id === tabStop ? 0 : -1}
          aria-label={describeCommunicator(item)}
          aria-pressed={selected}
          onclick={() => choose(id, selected)}
          onkeydown={(event) => keydown(event, id)}
          onfocus={() => (focusId = id)}
          onblur={() => (focusId === id ? (focusId = null) : null)}
          onpointerenter={() => (hoverId = id)}
          onpointerleave={() => (hoverId === id ? (hoverId = null) : null)}
        >
          <title>{describeCommunicator(item)}</title>
          <circle r="32" class="hit" fill="transparent" />
          <circle r="34" class="halo" fill="none" stroke="hsl(var(--ring))" stroke-width="3" opacity={lit ? 1 : 0} />
          {#if state === "closing"}<circle r="30" fill="none" stroke="hsl(var(--destructive))" stroke-width="2" class="pulse" />{/if}
          <circle r="24" fill="hsl(var(--card))" stroke={healthColor(state)} stroke-width="2.75" stroke-dasharray={state === "live" ? undefined : "5 4"} />
          <RadioTowerIcon x={-10} y={-10} size={20} class="text-foreground" />
          {#if item.node.agent_ids.length > 0}
            <g transform="translate(18 -18)">
              <circle r="10" fill="hsl(var(--primary))" />
              <text y="3.6" text-anchor="middle" class="count">{item.node.agent_ids.length}</text>
            </g>
          {/if}
          {#if scale >= 0.35 || lit}
            <text y="46" text-anchor="middle" class="node-label node-label--strong">{truncate(communicatorLabel(item.node), 24)}</text>
            <text y="59" text-anchor="middle" class="node-label node-label--muted">{item.ghost ? "disconnected" : `cxx ${item.node.version}`}</text>
          {/if}
        </g>
      {/each}

      {#each model.agents as item (item.node.id)}
        {@const id = item.node.id}
        {@const pos = at(id)}
        {@const selected = selectedId === id}
        {@const lit = selected || hoverId === id || focusId === id}
        {@const offline = item.node.presence === "offline" || item.node.presence === "ended" || item.ghost !== null}
        <g
          data-node={id}
          class="node node--agent"
          class:node--selected={selected}
          style:transform="translate({pos.x}px, {pos.y}px)"
          style:opacity={dimmed(id, item.node) ? 0.2 : item.strength}
          role="button"
          tabindex={id === tabStop ? 0 : -1}
          aria-label={describeAgent(item)}
          aria-pressed={selected}
          onclick={() => choose(id, selected)}
          onkeydown={(event) => keydown(event, id)}
          onfocus={() => (focusId = id)}
          onblur={() => (focusId === id ? (focusId = null) : null)}
          onpointerenter={() => (hoverId = id)}
          onpointerleave={() => (hoverId === id ? (hoverId = null) : null)}
        >
          <title>{describeAgent(item)}</title>
          <circle r="21" class="hit" fill="transparent" />
          <circle r="22" class="halo" fill="none" stroke="hsl(var(--ring))" stroke-width="3" opacity={lit ? 1 : 0} />
          {#if item.node.presence === "working" && !item.ghost}<circle r="16" fill="none" stroke="hsl(var(--success))" stroke-width="1.5" class="pulse" />{/if}
          <circle r="16" fill="hsl(var(--card))" stroke={presenceColor(item.node.presence)} stroke-width="2.25" stroke-dasharray={offline ? "3 3" : undefined} />
          <circle r="11" fill={engineColor(item.node.engine)} opacity={offline ? 0.55 : 1} />
          <text y="3.2" text-anchor="middle" class="engine-code">{engineCode(item.node.engine)}</text>
          {#if item.node.association.state === "stale"}
            <circle cx="12" cy="-12" r="4.5" fill="hsl(var(--warning))" stroke="hsl(var(--card))" stroke-width="1.5" />
          {/if}
          {#if showAgentLabels || lit || (query.trim() !== "" && matchesQuery(item.node, query))}
            {@const label = labelAt(pos)}
            <text x={label.x} y={label.y} text-anchor={label.anchor} class="node-label">{truncate(item.node.name, 18)}</text>
          {/if}
        </g>
      {/each}
    </g>
  </svg>

  {#if model.communicators.length === 0 && model.agents.length === 0}
    <div class="pointer-events-none absolute inset-x-0 bottom-6 mx-auto w-fit max-w-[80%] rounded-md border bg-background/90 px-3 py-2 text-center text-sm text-muted-foreground">
      Nothing is connected to this server right now.
    </div>
  {/if}

  <div class="absolute right-3 top-3 flex flex-col gap-1 rounded-md border bg-background/90 p-1 shadow-sm backdrop-blur" role="group" aria-label="Zoom">
    <button type="button" class="zoom-button" aria-label="Zoom in" onpointerdown={(e) => e.stopPropagation()} onclick={() => zoomAround(1.25)}><ZoomInIcon class="h-4 w-4" /></button>
    <button type="button" class="zoom-button" aria-label="Zoom out" onpointerdown={(e) => e.stopPropagation()} onclick={() => zoomAround(0.8)}><ZoomOutIcon class="h-4 w-4" /></button>
    <button type="button" class="zoom-button" aria-label="Fit to view" onpointerdown={(e) => e.stopPropagation()} onclick={resetView}><MaximizeIcon class="h-4 w-4" /></button>
  </div>
</div>

<style>
  .node { cursor: pointer; outline: none; transition: opacity 0.6s ease; }
  .node:focus-visible .halo, .node--selected .halo { opacity: 1 !important; }
  .halo { transition: opacity 0.15s ease; }
  .node-label { font: 600 11px/1 var(--font-sans, Inter, system-ui, sans-serif); fill: hsl(var(--foreground)); paint-order: stroke; stroke: hsl(var(--card)); stroke-width: 3.5px; stroke-linejoin: round; pointer-events: none; }
  .node-label--strong { font-size: 12px; font-weight: 650; }
  .node-label--muted { font-size: 10px; font-weight: 500; fill: hsl(var(--muted-foreground)); }
  .count { font: 700 10px/1 var(--font-sans, Inter, system-ui, sans-serif); fill: hsl(var(--primary-foreground)); pointer-events: none; }
  .engine-code { font: 700 9px/1 var(--font-sans, Inter, system-ui, sans-serif); fill: #fff; pointer-events: none; }
  .zoom-button { display: grid; height: 2rem; width: 2rem; place-items: center; border-radius: 0.375rem; color: hsl(var(--muted-foreground)); outline: none; }
  .zoom-button:hover { background: hsl(var(--muted)); color: hsl(var(--foreground)); }
  .zoom-button:focus-visible { box-shadow: 0 0 0 2px hsl(var(--ring)); }
  .edge-flow { stroke-dasharray: 3 7; animation: flow 1.4s linear infinite; }
  .pulse { transform-box: fill-box; transform-origin: center; animation: pulse 1.8s ease-out infinite; }
  @keyframes flow { to { stroke-dashoffset: -20; } }
  @keyframes pulse { 0% { transform: scale(0.9); opacity: 0.9; } 100% { transform: scale(1.7); opacity: 0; } }
  @media (prefers-reduced-motion: reduce) {
    .edge-flow, .pulse { animation: none; }
    .node { transition: none; }
  }
</style>
