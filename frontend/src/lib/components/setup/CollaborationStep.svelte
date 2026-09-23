<script lang="ts">
  /**
   * The two collaboration surfaces, both deliberately off on a fresh install.
   *
   * These are the only switches in the wizard where "off" is a security posture
   * rather than an unset value, so both spell out what turning them on actually
   * does rather than offering a bare toggle.
   *
   * The portal additionally needs `PUBLIC_BASE_URL`; the server enforces that
   * with a 503 rather than silently half-enabling, and it is already a critical
   * readiness check, so by the time anyone reaches this step it is satisfied.
   */
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Alert, AlertDescription, AlertTitle } from "$lib/components/ui/alert";
  import { CopyButton } from "$lib/components/ui/copy-button";
  import { api } from "$lib/api/client";
  import { autoCopyText } from "$lib/utils/clipboard";
  import ModuleSwitchRow from "$lib/components/layout/ModuleSwitchRow.svelte";
  import StepQueryState from "./StepQueryState.svelte";

  type PortalState = { enabled: boolean; configured?: boolean };
  type MessagingState = { enabled: boolean };

  const qc = useQueryClient();

  const portal = createQuery({
    queryKey: ["agent-portal", "state"],
    queryFn: () => api.get<PortalState>("/admin/agent-portal/state"),
  });
  const messaging = createQuery({
    queryKey: ["agent-messaging", "state"],
    queryFn: () => api.get<MessagingState>("/admin/agent-messaging/state"),
  });

  let portalOn = $state(false);
  let messagingOn = $state(false);
  let portalUser = $state("");
  let magicUrl = $state<string | null>(null);
  let saving = $state(false);
  let creatingUser = $state(false);
  let portalLoaded = $state(false);
  let messagingLoaded = $state(false);

  const loading = $derived($portal.isLoading || $messaging.isLoading);
  const loadError = $derived($portal.error?.message ?? $messaging.error?.message ?? null);
  /** A named portal user not yet created: the footer creates it first. */
  const userPending = $derived(portalOn && portalUser.trim() !== "" && magicUrl === null);

  $effect(() => {
    const value = $portal.data?.enabled;
    if (!portalLoaded && typeof value === "boolean") {
      portalOn = value;
      portalLoaded = true;
    }
  });
  $effect(() => {
    const value = $messaging.data?.enabled;
    if (!messagingLoaded && typeof value === "boolean") {
      messagingOn = value;
      messagingLoaded = true;
    }
  });

  /** Function, not `$derived`: derived state cannot be exported from a
  * component. The caller's own `$derived` still tracks what this reads. */
  export function isBusy(): boolean {
    return saving || creatingUser;
  }

  /** Footer label; reflects whether pressing it will also create a portal user. */
  export function primaryLabel(): string {
    return userPending ? "Create user and save" : "Save and continue";
  }

  async function createPortalUser(): Promise<boolean> {
    const label = portalUser.trim();
    creatingUser = true;
    try {
      // The portal must be on before a user is worth anything, so persist the
      // switch first if the operator flipped it in this session.
      if (portalOn && portalOn !== ($portal.data?.enabled ?? false)) {
        await api.post("/admin/agent-portal/state", { enabled: true });
        void qc.invalidateQueries({ queryKey: ["agent-portal"] });
      }
      const result = await api.post<{ magic_url: string }>("/admin/agent-portal/users", {
        display_name: label,
      });
      magicUrl = result.magic_url;
      void qc.invalidateQueries({ queryKey: ["agent-portal"] });
      await autoCopyText(result.magic_url, "Magic link copied", "Magic link ready");
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create the portal user");
      return false;
    } finally {
      creatingUser = false;
    }
  }

  /**
   * Returns false — hold position — after creating a portal user, because its
   * sign-in link is shown exactly once and advancing would scroll it away. The
   * next press saves and advances without creating another user.
   */
  export async function persist(): Promise<boolean> {
    if (userPending) {
      await createPortalUser();
      return false;
    }
    saving = true;
    try {
      // Unloaded state is never written; see ModulesStep.
      if (portalLoaded && portalOn !== ($portal.data?.enabled ?? false)) {
        await api.post("/admin/agent-portal/state", { enabled: portalOn });
        void qc.invalidateQueries({ queryKey: ["agent-portal"] });
      }
      if (messagingLoaded && messagingOn !== ($messaging.data?.enabled ?? false)) {
        await api.post("/admin/agent-messaging/state", { enabled: messagingOn });
        void qc.invalidateQueries({ queryKey: ["agent-messaging"] });
      }
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save collaboration settings");
      return false;
    } finally {
      saving = false;
    }
  }
</script>

{#snippet portalNotice()}
  <div class="space-y-2">
    <Label for="setup-portal-user" class="text-xs">First portal user (optional)</Label>
    <Input
      id="setup-portal-user"
      bind:value={portalUser}
      placeholder="Your name"
      class="max-w-xs"
      disabled={magicUrl !== null}
    />
    {#if magicUrl}
      <Alert variant="warning">
        <AlertTitle>Sign-in link — shown once</AlertTitle>
        <AlertDescription>
          <p class="mb-2 break-all font-mono text-xs">{magicUrl}</p>
          <div class="flex items-center gap-2">
            <CopyButton value={magicUrl} label="Copy link" toastMessage="Link copied" />
            <span class="text-xs">
              It cannot be shown again; a new one can be minted from the portal page.
            </span>
          </div>
        </AlertDescription>
      </Alert>
    {:else}
      <p class="text-xs text-muted-foreground">
        Name one and <strong>Create user and save</strong> below mints their sign-in link.
      </p>
    {/if}
  </div>
{/snippet}

<div class="space-y-3">
  {#if loading || loadError}
    <StepQueryState
      {loading}
      error={loadError}
      subject="collaboration settings"
      onRetry={() => {
        void $portal.refetch();
        void $messaging.refetch();
      }}
    />
  {:else}
    <ModuleSwitchRow
      id="setup-portal"
      class="rounded-lg border"
      label="Agent Portal"
      description="A permanent web page where you talk to a running agent from a browser or phone. Portal text reaches the agent as ordinary user input — it cannot approve a tool action, grant credentials or widen scope."
      checked={portalOn}
      onCheckedChange={(v) => (portalOn = v)}
      notice={portalOn ? portalNotice : undefined}
    />
    <ModuleSwitchRow
      id="setup-messaging"
      class="rounded-lg border"
      label="Agent Messaging"
      description="Lets agents on different hosts message each other. One fleet-wide switch: turning it on enables the bus for every active host, insecure ones included, and adds an Agent Messaging section to every host's AGENTS.md / CLAUDE.md. Peer text is treated as ordinary model input, never as authorization."
      checked={messagingOn}
      onCheckedChange={(v) => (messagingOn = v)}
    />
  {/if}
</div>
