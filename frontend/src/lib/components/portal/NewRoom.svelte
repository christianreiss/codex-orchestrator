<script lang="ts">
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import * as Dialog from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import { api } from "$lib/api/client";
  import { roomKeys, roomRoot } from "$lib/api/roomChats";
  import type { AgentAddress } from "$lib/api/agentMessaging";
  let {
    open = $bindable(false),
    oncreated,
  }: { open?: boolean; oncreated: (id: string) => void } = $props();
  const client = useQueryClient();
  const agents = createQuery({
    queryKey: ["agent-messaging", "chat-candidates"],
    queryFn: () =>
      api.get<{ addresses: AgentAddress[] }>(
        "/admin/agent-messaging/addresses",
      ),
  });
  let kind = $state<"group" | "conference">("group"),
    title = $state(""),
    description = $state(""),
    members = $state<string[]>([]),
    duration = $state(60),
    search = $state("");
  let busy = $state(false),
    error = $state("");
  let pending = $state<Record<string, unknown> | null>(null);
  const candidates = $derived(
    ($agents.data?.addresses ?? []).filter(
      (a) =>
        a.engine !== "server" &&
        `${a.name ?? a.alias ?? a.address} ${a.fqdn ?? ""}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    ),
  );
  async function create() {
    if (!title.trim() || busy) return;
    pending ??= {
      client_request_id: crypto.randomUUID(),
      kind,
      title: title.trim(),
      description,
      members,
      duration_minutes: duration,
    };
    busy = true;
    error = "";
    try {
      const result = await api.post<{ room_id: string }>(
        `${roomRoot}/create`,
        pending,
      );
      await client.invalidateQueries({ queryKey: roomKeys });
      pending = null;
      title = "";
      description = "";
      members = [];
      open = false;
      oncreated(result.room_id);
    } catch (e) {
      error =
        e instanceof Error
          ? e.message
          : "Creation could not be confirmed. Retry uses the same request.";
    } finally {
      busy = false;
    }
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
    <Dialog.Header
      ><Dialog.Title>New conversation</Dialog.Title><Dialog.Description
        >Bring agents together around a shared topic.</Dialog.Description
      ></Dialog.Header
    >
    <form
      class="space-y-4"
      onsubmit={(e) => {
        e.preventDefault();
        void create();
      }}
    >
      <fieldset disabled={busy || !!pending} class="space-y-4">
        <label class="block text-body-sm"
          >Conversation type<select
            class="mt-1 h-9 w-full rounded border border-input bg-background px-3"
            bind:value={kind}
            ><option value="group">Group</option><option value="conference"
              >Conference · you chair</option
            ></select
          ></label
        >
        <label class="block text-body-sm"
          >{kind === "group" ? "Name" : "Topic"}<input
            required
            maxlength="120"
            class="mt-1 h-9 w-full rounded border border-input bg-background px-3"
            bind:value={title}
          /></label
        >
        <label class="block text-body-sm"
          >Description<textarea
            maxlength="1024"
            class="mt-1 w-full rounded border border-input bg-background p-3"
            rows="2"
            bind:value={description}></textarea></label
        >
        {#if kind === "conference"}<label class="block text-body-sm"
            >Duration<select
              class="mt-1 h-9 w-full rounded border border-input bg-background px-3"
              bind:value={duration}
              ><option value={30}>30 minutes</option><option value={60}
                >1 hour</option
              ><option value={180}>3 hours</option><option value={360}
                >6 hours</option
              ></select
            ></label
          >{/if}
        <fieldset class="space-y-2">
          <legend class="mb-2 text-body-sm font-medium"
            >Participants <span class="text-muted-foreground"
              >({members.length})</span
            ></legend
          >
          <input
            aria-label="Find participants"
            placeholder="Find an agent…"
            class="h-9 w-full rounded border border-input bg-background px-3 text-body-sm"
            bind:value={search}
          />
          {#if $agents.isPending}<p role="status">
              Loading agents…
            </p>{:else if $agents.isError}<p role="alert">
              Could not load agents.
            </p>
            <Button
              type="button"
              variant="outline"
              onclick={() => $agents.refetch()}>Retry</Button
            >{:else}
            <div class="max-h-44 overflow-y-auto">
              {#each candidates as agent (agent.id)}<label
                  class="flex min-h-11 items-center gap-3 border-b py-2 text-body-sm"
                  ><input
                    type="checkbox"
                    value={agent.id}
                    bind:group={members}
                  /><span class="min-w-0 flex-1 break-words"
                    >{agent.name ?? agent.alias ?? agent.address}<span
                      class="block text-caption text-muted-foreground"
                      >{agent.engine} · {agent.fqdn ?? "Host unavailable"}</span
                    ></span
                  ></label
                >{/each}{#if !candidates.length}<p
                  class="py-3 text-body-sm text-muted-foreground"
                >
                  No agents match.
                </p>{/if}
            </div>
          {/if}
        </fieldset>
      </fieldset>
      {#if error}<p role="alert" class="text-body-sm text-destructive">
          {error} Your request is retained; retry to confirm its outcome.
        </p>{/if}
      <Dialog.Footer
        ><Button
          type="button"
          variant="ghost"
          disabled={busy}
          onclick={() => (open = false)}>Close</Button
        ><Button type="submit" disabled={busy || !title.trim()}
          >{busy
            ? "Creating…"
            : pending
              ? "Retry creation"
              : kind === "group"
                ? "Create group"
                : "Open conference"}</Button
        ></Dialog.Footer
      >
    </form>
  </Dialog.Content>
</Dialog.Root>
