<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { PageShell } from "$lib/components/page";
  import { authStore } from "$lib/stores/auth";
  import * as Tabs from "$lib/components/ui/tabs";
  import { SETTINGS_GROUPS, SETTINGS_GROUP_LABEL, isSettingsGroup, settingsGroupForHash, type SettingsGroup } from "$lib/components/settings/settings-anchors";
  import HostsTab from "$lib/components/settings/tabs/HostsTab.svelte";
  import AgentsTab from "$lib/components/settings/tabs/AgentsTab.svelte";
  import RolloutTab from "$lib/components/settings/tabs/RolloutTab.svelte";
  import RetentionTab from "$lib/components/settings/tabs/RetentionTab.svelte";

  const canManage = $derived($authStore.can("settings.manage"));

  // One group at a time; the tab lives in the URL so a reload or shared link lands on it.
  // Only the open tab is mounted, so its queries are the only ones that fire.
  const requested = $derived(page.url.searchParams.get("group") ?? "");
  const current = $derived<SettingsGroup>(isSettingsGroup(requested) ? requested : "hosts");

  function selectGroup(group: string) {
    if (!isSettingsGroup(group)) return;
    void goto(`?group=${group}`, { replaceState: true, noScroll: true, keepFocus: true });
  }

  let followedHash = "";

  async function follow(hash: string) {
    followedHash = hash;
    const group = settingsGroupForHash(hash);
    if (group && group !== current) await goto(`?group=${group}${hash}`, { replaceState: true, noScroll: true, keepFocus: true });
    const id = hash.replace(/^#/, "");
    if (!id) return;
    await tick();
    // Rows above the target load after the first paint and push it down: scroll again once they settle.
    for (const delay of [0, 250, 700]) {
      setTimeout(() => requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: "start" })), delay);
    }
  }

  // A client-side navigation (the command palette) changes the hash without `hashchange`.
  $effect(() => {
    const hash = page.url.hash;
    untrack(() => { if (hash && hash !== followedHash) void follow(hash); });
  });

  onMount(() => {
    void follow(location.hash);
    const onHash = () => void follow(location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  });
</script>

<PageShell title="Settings" description="Fleet-wide behaviour. Switches save immediately; forms use Save changes. Individual hosts can override some settings; a badge shows how many.">
  {#if !canManage}
    <p class="text-body-sm text-muted-foreground">Read only. Changing these settings requires <code class="font-mono">settings.manage</code>. Agent coordination, the supervisor and the rollout have their own permissions, shown beside each.</p>
  {/if}

  <Tabs.Root value={current} onValueChange={selectGroup} class="flex flex-col gap-4">
    <!-- At 320 px the tabs scroll inside this strip, never the page. -->
    <div class="-m-1 max-w-full overflow-x-auto p-1">
      <Tabs.List class="w-max justify-start" aria-label="Settings groups">
        {#each SETTINGS_GROUPS as group (group)}
          <Tabs.Trigger value={group} class="shrink-0">{SETTINGS_GROUP_LABEL[group]}</Tabs.Trigger>
        {/each}
      </Tabs.List>
    </div>

    <Tabs.Content value="hosts" class="space-y-8">{#if current === "hosts"}<HostsTab />{/if}</Tabs.Content>
    <Tabs.Content value="agents" class="space-y-8">{#if current === "agents"}<AgentsTab />{/if}</Tabs.Content>
    <Tabs.Content value="rollout" class="space-y-8">{#if current === "rollout"}<RolloutTab />{/if}</Tabs.Content>
    <Tabs.Content value="retention" class="space-y-8">{#if current === "retention"}<RetentionTab />{/if}</Tabs.Content>
  </Tabs.Root>
</PageShell>
