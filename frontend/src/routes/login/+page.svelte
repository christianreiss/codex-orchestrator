<script lang="ts">
  import { onMount } from "svelte";
  import BrandMark from "$lib/components/brand/BrandMark.svelte";
  import { goto } from "$app/navigation";
  import { base } from "$app/paths";
  import { page } from "$app/state";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { AuthShell } from "$lib/components/page";
  import { FormField } from "$lib/components/ui/form-field";
  import { Alert, AlertDescription } from "$lib/components/ui/alert";
  import Fingerprint from "@lucide/svelte/icons/fingerprint";
  import { api, ApiError } from "$lib/api/client";
  import { authenticatePasskey, type PublicKeyAuthenticationOptionsJSON } from "$lib/components/account/webauthn";
  import { authActions, authStore } from "$lib/stores/auth";
  import { requestPasswordReset } from "$lib/api/account";

  let username = $state("");
  let password = $state("");
  let phase = $state<"username" | "password" | "passkey" | "reset">("username");
  let probing = $state(false);
  let submitting = $state(false);
  let error = $state<string | null>(null);
  let passkeySupported = $state(false);
  let autoPasskeyActive = $state(false);
  let resetRequested = $state(false);

  type LoginMethodResponse = {
    method?: "password" | "passkey" | "none";
    methods?: string[];
    username?: string;
  };

  /**
   * Where to land after sign-in. `?next=` is a base-relative path (e.g.
   * `/setup`); anything that is not a single-slash path is dropped so the
   * parameter cannot become an open redirect.
   */
  function landing(): string {
    const next = page.url.searchParams.get("next");
    if (next && /^\/(?!\/)/.test(next) && !next.includes("\\")) return `${base}${next}`;
    return `${base}/dashboard`;
  }

  onMount(() => {
    // If we're already authenticated, bounce.
    let signedIn = false;
    const unsub = authStore.subscribe((s) => {
      signedIn = s.authenticated && !s.loading;
      if (s.authenticated && !s.loading) {
        void goto(landing(), { replaceState: true });
      }
    });
    passkeySupported = typeof PublicKeyCredential !== "undefined";
    if (passkeySupported) {
      window.setTimeout(() => {
        if (!signedIn && phase === "username" && !username.trim()) {
          void submitPasskey(true);
        }
      }, 0);
    }
    return unsub;
  });

  async function probeMethod() {
    if (!username.trim()) {
      error = "Enter your username.";
      return;
    }
    error = null;
    probing = true;
    try {
      const res = await api.post<LoginMethodResponse>("/admin/auth/login/method", {
        username: username.trim(),
      });
      const methods = res.methods ?? (res.method ? [res.method] : []);
      if (methods.includes("passkey")) {
        phase = "passkey";
      } else {
        phase = "password";
      }
    } catch (err) {
      // Even if probe fails, allow password attempt.
      phase = "password";
      if (err instanceof ApiError) error = err.message;
    } finally {
      probing = false;
    }
  }

  async function submitPassword() {
    error = null;
    submitting = true;
    try {
      await authActions.login({ username: username.trim(), password, method: "password" });
      void goto(landing(), { replaceState: true });
    } catch (err) {
      error = err instanceof ApiError ? err.message : "Sign-in failed.";
    } finally {
      submitting = false;
    }
  }

  async function submitPasskey(auto = false) {
    error = null;
    if (auto) {
      autoPasskeyActive = true;
      phase = "passkey";
    }
    submitting = true;
    try {
      const trimmedUsername = username.trim();
      const options = await api.post<PublicKeyAuthenticationOptionsJSON>(
        "/admin/auth/passkey/login/options",
        trimmedUsername ? { username: trimmedUsername } : {},
      );
      const response = await authenticatePasskey(options);
      await api.post(
        "/admin/auth/passkey/login",
        trimmedUsername ? { response, username: trimmedUsername } : { response },
      );
      await authActions.refresh();
      void goto(landing(), { replaceState: true });
    } catch (err) {
      if (auto) {
        phase = "username";
        error = null;
      } else {
        error = err instanceof Error ? err.message : "Passkey sign-in failed.";
      }
    } finally {
      submitting = false;
      autoPasskeyActive = false;
    }
  }

  async function submitResetRequest() {
    if (!username.trim()) {
      error = "Enter your username or email.";
      return;
    }
    error = null;
    submitting = true;
    try {
      await requestPasswordReset({ username: username.trim() });
      resetRequested = true;
    } catch (err) {
      error = err instanceof ApiError ? err.message : "Could not request a reset link.";
    } finally {
      submitting = false;
    }
  }


  function back(to: "username" | "reset") {
    phase = to;
    password = "";
    error = null;
    resetRequested = false;
  }

  const title = $derived(phase === "reset" ? "Reset password" : "Sign in");
  const description = $derived(
    phase === "reset" ? "Request a one-time reset link for your admin account." : "Authenticate to access the admin console.",
  );
  const linkClass = "block w-full text-center text-body-sm text-muted-foreground underline-offset-2 hover:underline";
</script>

<AuthShell {title} {description}>
  <div class="space-y-4">
    {#if error}
      <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>
    {/if}

    <form
      class="space-y-4"
      onsubmit={(e) => {
        e.preventDefault();
        if (phase === "username") void probeMethod();
        else if (phase === "password") void submitPassword();
        else if (phase === "passkey") void submitPasskey();
        else void submitResetRequest();
      }}
    >
      {#if phase !== "passkey" || username.trim()}
        <FormField id="username" label={phase === "reset" ? "Username or email" : "Username"}>
          <Input id="username" type="text" autocomplete="username" required bind:value={username} disabled={phase !== "username" && phase !== "reset"} />
        </FormField>
      {/if}

      {#if phase === "reset" && resetRequested}
        <Alert>
          <AlertDescription>If an active account matches that username or email, a reset link has been sent to its registered email address.</AlertDescription>
        </Alert>
      {/if}

      {#if phase === "password"}
        <FormField id="password" label="Password">
          <Input id="password" type="password" autocomplete="current-password" required bind:value={password} />
        </FormField>
      {/if}

      {#if phase === "passkey"}
        <p class="text-body-sm text-muted-foreground">
          Use your registered passkey to sign in{#if username.trim()} as <strong>{username}</strong>{/if}.
        </p>
      {/if}

      {#if autoPasskeyActive}
        <div class="flex w-full items-center justify-center gap-2 rounded-md border border-input bg-muted px-4 py-2 text-body-sm text-muted-foreground">
          <Fingerprint class="h-4 w-4" /> Waiting for passkey…
        </div>
      {:else}
        <Button type="submit" class="w-full" disabled={submitting || probing}>
          {#if phase === "username"}Continue
          {:else if phase === "password"}Sign in
          {:else if phase === "reset"}{resetRequested ? "Send another link" : "Send reset link"}
          {:else}<Fingerprint class="h-4 w-4" /> Authenticate with passkey{/if}
        </Button>
      {/if}

      {#if phase === "password" && passkeySupported}
        <Button type="button" variant="outline" class="w-full" onclick={() => (phase = "passkey")}>
          <Fingerprint class="h-4 w-4" /> Use a passkey instead
        </Button>
      {/if}

      {#if phase === "password" || phase === "passkey"}
        <button type="button" class={linkClass} onclick={() => back("reset")}>
          {phase === "passkey" ? "Lost your passkey?" : "Forgot password?"}
        </button>
      {/if}
      {#if phase !== "username"}
        <button type="button" class={linkClass} onclick={() => back("username")}>
          {phase === "reset" ? "Back to sign in" : "Use a different username"}
        </button>
      {/if}
    </form>
  </div>

  {#snippet footer()}
    <p class="text-center text-body-sm text-muted-foreground">Need help? Contact your fleet administrator.</p>
    <p class="flex items-center justify-center gap-2 text-body-sm text-muted-foreground">
      <BrandMark class="h-5 w-5" /> Codex Orchestrator
    </p>
  {/snippet}
</AuthShell>
