<script lang="ts">
  import type { Scope } from "$lib/api/connectors";
  let {
    value = $bindable(),
    hosts,
    projects,
    disabled = false,
  }: {
    value: Scope;
    hosts: { id: number; name: string }[];
    projects: string[];
    disabled?: boolean;
  } = $props();
  const categories = [
    "hosts",
    "projects",
    "memory",
    "content",
    "coordination",
    "workflows",
    "feedback",
  ];
  const sensitive = [
    "secrets.metadata",
    "secrets.reveal",
    "delete",
    "delegate",
  ];
  function toggleHost(id: number, checked: boolean) {
    value.hosts = checked
      ? [...value.hosts, id]
      : value.hosts.filter((v) => v !== id);
  }
  function toggleProject(id: string, checked: boolean) {
    value.projects = checked
      ? [...value.projects, id]
      : value.projects.filter((v) => v !== id);
  }
</script>

<fieldset {disabled} class="space-y-4">
  <legend class="font-medium">Permissions</legend>
  <div class="grid gap-3 sm:grid-cols-2">
    {#each categories as category}
      <label class="flex items-center justify-between gap-3"
        ><span class="capitalize">{category}</span><select
          aria-label={`${category} access`}
          class="rounded border border-input bg-background p-2"
          value={value.categories[category] ?? "off"}
          onchange={(e) => {
            const mode = e.currentTarget.value;
            if (mode === "off") delete value.categories[category];
            else value.categories[category] = mode as "ro" | "rw";
          }}
          ><option value="off">No access</option><option value="ro"
            >Read only</option
          ><option value="rw">Read and write</option></select
        ></label
      >
    {/each}
  </div>
  <fieldset class="space-y-2">
    <legend class="font-medium">Managed hosts</legend>
    {#each hosts as host}<label class="flex min-h-10 items-center gap-2"
        ><input
          type="checkbox"
          checked={value.hosts.includes(host.id)}
          onchange={(e) => toggleHost(host.id, e.currentTarget.checked)}
        />{host.name}</label
      >{/each}
    {#if !hosts.length}<p class="text-muted-foreground">
        No managed hosts available.
      </p>{/if}
  </fieldset>
  <fieldset class="space-y-2">
    <legend class="font-medium">Projects</legend>
    {#each projects as project}<label class="flex min-h-10 items-center gap-2"
        ><input
          type="checkbox"
          checked={value.projects.includes(project)}
          onchange={(e) => toggleProject(project, e.currentTarget.checked)}
        />{project}</label
      >{/each}
  </fieldset>
  <label class="flex min-h-10 items-center gap-2"
    ><input type="checkbox" bind:checked={value.global} />Allow fleet-wide
    shared data</label
  >
  <fieldset class="space-y-2">
    <legend class="font-medium">Sensitive operations</legend>
    <p class="text-body-sm text-muted-foreground">
      Delegation can execute arbitrary work with the managed agent's authority.
      Read and write access alone never grants these operations.
    </p>
    {#each sensitive as name}<label class="flex min-h-10 items-center gap-2"
        ><input
          type="checkbox"
          checked={value.sensitive.includes(name)}
          onchange={(e) =>
            (value.sensitive = e.currentTarget.checked
              ? [...value.sensitive, name]
              : value.sensitive.filter((v) => v !== name))}
        />{name}</label
      >{/each}
  </fieldset>
  <label class="block space-y-1"
    ><span
      >Restrict to tool names (comma separated, empty allows eligible tools)</span
    ><input
      class="w-full rounded border border-input bg-background p-2"
      value={value.tools.join(", ")}
      onchange={(e) =>
        (value.tools = e.currentTarget.value
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean))}
    /></label
  >
</fieldset>
