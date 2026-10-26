<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { PageShell, Section } from "$lib/components/page";
  import * as Tabs from "$lib/components/ui/tabs";
  import ProfileSection from "$lib/components/account/ProfileSection.svelte";
  import PasswordForm from "$lib/components/account/PasswordForm.svelte";
  import PasskeyList from "$lib/components/account/PasskeyList.svelte";
  import ThemePicker from "$lib/components/account/ThemePicker.svelte";
  import DeviceList from "$lib/components/account/DeviceList.svelte";

  const tabs = [
    { value: "profile", label: "Profile" },
    { value: "security", label: "Security" },
    { value: "appearance", label: "Appearance" },
    { value: "devices", label: "Devices" },
  ];
  const current = $derived(tabs.find((tab) => `#${tab.value}` === page.url.hash)?.value ?? "profile");
  function selectTab(value: string) {
    if (value === current || !tabs.some((tab) => tab.value === value)) return;
    void goto(`${page.url.pathname}${page.url.search}#${value}`, { noScroll: true, keepFocus: true });
  }
</script>

<svelte:head><title>Account · Orchestrator</title></svelte:head>

<PageShell title="Account" description="Your profile, sign-in security, appearance and paired devices." width="narrow">
  <Tabs.Root value={current} onValueChange={selectTab} class="space-y-6">
    <Tabs.List aria-label="Account settings" class="grid w-full grid-cols-4 sm:w-fit">
      {#each tabs as tab (tab.value)}
        <Tabs.Trigger value={tab.value} class="min-h-11 px-1.5 sm:px-4">{tab.label}</Tabs.Trigger>
      {/each}
    </Tabs.List>

    <!-- Keep drafts mounted across tab changes; inactive panels are hidden and inert. -->
    <Tabs.Content value="profile" class={current !== "profile" ? "hidden" : ""} inert={current !== "profile"}>
      <Section id="profile" title="Profile"><ProfileSection /></Section>
    </Tabs.Content>
    <Tabs.Content value="security" class={current !== "security" ? "hidden" : ""} inert={current !== "security"}>
      <Section id="security" title="Security" description="Manage how you sign in to this console.">
        <div class="space-y-8">
          <details class="group border-b pb-5">
            <summary class="min-h-11 cursor-pointer content-center rounded-sm text-body font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">Change password</summary>
            <div class="pt-4"><PasswordForm /></div>
          </details>
          <div>
            <h3 class="mb-2 text-body font-medium">Passkeys</h3>
            <PasskeyList />
          </div>
        </div>
      </Section>
    </Tabs.Content>
    <Tabs.Content value="appearance" class={current !== "appearance" ? "hidden" : ""} inert={current !== "appearance"}>
      <Section id="appearance" title="Appearance" description="Choose how the console looks on your devices."><ThemePicker /></Section>
    </Tabs.Content>
    <Tabs.Content value="devices" class={current !== "devices" ? "hidden" : ""} inert={current !== "devices"}>
      <Section id="devices" title="Android devices"><DeviceList /></Section>
    </Tabs.Content>
  </Tabs.Root>
</PageShell>
