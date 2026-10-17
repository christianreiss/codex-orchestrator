<script lang="ts">
  /** One account page: who you are, how you sign in, how it looks, which phones are paired. */
  import { PageShell, Section } from "$lib/components/page";
  import ProfileSection from "$lib/components/account/ProfileSection.svelte";
  import PasswordForm from "$lib/components/account/PasswordForm.svelte";
  import PasskeyList from "$lib/components/account/PasskeyList.svelte";
  import ThemePicker from "$lib/components/account/ThemePicker.svelte";
  import DeviceList from "$lib/components/account/DeviceList.svelte";
</script>

<PageShell title="Account" description="Your profile, sign-in security, appearance and paired devices." width="narrow">
  <div class="flex flex-col gap-8">
    <Section id="profile" title="Profile">
      <ProfileSection />
    </Section>
    <Section id="security" title="Security" description="Password and passkeys for signing in to this console.">
      <div class="space-y-6">
        <div>
          <h3 class="mb-2 text-body font-medium">Password</h3>
          <PasswordForm />
        </div>
        <div>
          <h3 class="mb-2 text-body font-medium">Passkeys</h3>
          <PasskeyList />
        </div>
      </div>
    </Section>
    <Section id="appearance" title="Appearance" description="Light, dark, or follow your system.">
      <ThemePicker />
    </Section>
    <Section id="devices" title="Android devices">
      <DeviceList />
    </Section>
  </div>
</PageShell>
