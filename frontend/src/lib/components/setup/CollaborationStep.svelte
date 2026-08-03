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
  import { Switch } from "$lib/components/ui/switch";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Alert, AlertDescription, AlertTitle } from "$lib/components/ui/alert";
  import { CopyButton } from "$lib/components/ui/copy-button";
  import { api } from "$lib/api/client";
  import { autoCopyText } from "$lib/utils/clipboard";

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
  let portalLoaded = false;
  let messagingLoaded = false;

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
    return saving;
  }

  async function createPortalUser(): Promise<void> {
    const label = portalUser.trim();
    if (!label) {
      toast.error("Give the portal user a name first.");
      return;
    }
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
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create the portal user");
    } finally {
      creatingUser = false;
    }
  }

  export async function persist(): Promise<boolean> {
    saving = true;
    try {
      if (portalOn !== ($portal.data?.enabled ?? false)) {
        await api.post("/admin/agent-portal/state", { enabled: portalOn });
        void qc.invalidateQueries({ queryKey: ["agent-portal"] });
      }
      if (messagingOn !== ($messaging.data?.enabled ?? false)) {
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

<div class="space-y-5">
  <div class="rounded-lg border p-4">
    <div class="flex items-start justify-between gap-4">
      <div class="space-y-1">
        <Label for="setup-portal" class="text-sm font-medium">Agent Portal</Label>
        <p class="text-xs text-muted-foreground">
          A permanent web page where you talk to a running agent from a browser or phone.
          Portal text reaches the agent as ordinary user input — it cannot approve a tool
          action, grant credentials or widen scope.
        </p>
      </div>
      <Switch id="setup-portal" checked={portalOn} onCheckedChange={(v) => (portalOn = v)} />
    </div>

    {#if portalOn}
      <div class="mt-4 space-y-2 border-t pt-4">
        <Label for="setup-portal-user" class="text-xs">First portal user</Label>
        <div class="flex gap-2">
          <Input
            id="setup-portal-user"
            bind:value={portalUser}
            placeholder="Your name"
            class="max-w-xs"
          />
          <Button variant="outline" size="sm" onclick={createPortalUser} disabled={creatingUser}>
            {creatingUser ? "Creating…" : "Create"}
          </Button>
        </div>
        {#if magicUrl}
          <Alert>
            <AlertTitle>Sign-in link — shown once</AlertTitle>
            <AlertDescription>
              <p class="mb-2 break-all font-mono text-[11px]">{magicUrl}</p>
              <div class="flex items-center gap-2">
                <CopyButton value={magicUrl} label="Copy link" toastMessage="Link copied" />
                <span class="text-[11px] text-muted-foreground">
                  It is not retrievable afterwards; a new one can be minted from the portal
                  page.
                </span>
              </div>
            </AlertDescription>
          </Alert>
        {/if}
      </div>
    {/if}
  </div>

  <div class="flex items-start justify-between gap-4 rounded-lg border p-4">
    <div class="space-y-1">
      <Label for="setup-messaging" class="text-sm font-medium">Agent Messaging</Label>
      <p class="text-xs text-muted-foreground">
        Lets agents on different hosts message each other. One fleet-wide switch: turning
        it on enables the bus for every active host, insecure ones included. Peer text is
        treated as ordinary model input, never as authorization.
      </p>
    </div>
    <Switch id="setup-messaging" checked={messagingOn} onCheckedChange={(v) => (messagingOn = v)} />
  </div>
</div>
