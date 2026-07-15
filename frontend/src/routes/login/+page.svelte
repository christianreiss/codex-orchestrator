<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { base } from "$app/paths";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import * as Card from "$lib/components/ui/card";
  import { Alert, AlertDescription } from "$lib/components/ui/alert";
  import Fingerprint from "@lucide/svelte/icons/fingerprint";
  import { api, ApiError } from "$lib/api/client";
  import { authenticatePasskey, type PublicKeyAuthenticationOptionsJSON } from "$lib/components/account/webauthn";
  import { authActions, authStore } from "$lib/stores/auth";

  let username = $state("");
  let password = $state("");
  let phase = $state<"username" | "password" | "passkey">("username");
  let probing = $state(false);
  let submitting = $state(false);
  let error = $state<string | null>(null);
  let passkeySupported = $state(false);
  let autoPasskeyActive = $state(false);

  type LoginMethodResponse = {
    method?: "password" | "passkey" | "none";
    methods?: string[];
    username?: string;
  };

  onMount(() => {
    // If we're already authenticated, bounce.
    let signedIn = false;
    const unsub = authStore.subscribe((s) => {
      signedIn = s.authenticated && !s.loading;
      if (s.authenticated && !s.loading) {
        void goto(`${base}/dashboard`, { replaceState: true });
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
      void goto(`${base}/dashboard`, { replaceState: true });
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
      void goto(`${base}/dashboard`, { replaceState: true });
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
</script>

<div
  class="standalone-surface flex min-h-full items-center justify-center px-4 py-12"
>
  <div class="w-full max-w-md">
    <div class="mb-6 flex items-center justify-center gap-3">
      <div
        class="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 via-violet-500 to-fuchsia-500 text-lg font-bold text-white shadow-lg shadow-primary/20"
        aria-hidden="true"
      >
        C
      </div>
      <span class="text-lg font-semibold tracking-tight">Codex Orchestrator</span>
    </div>

    <Card.Root>
      <Card.Header>
        <Card.Title>Sign in</Card.Title>
        <Card.Description>Authenticate to access the admin console.</Card.Description>
      </Card.Header>
      <Card.Content class="space-y-4">
        {#if error}
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        {/if}

        <form
          class="space-y-4"
          onsubmit={(e) => {
            e.preventDefault();
            if (phase === "username") void probeMethod();
            else if (phase === "password") void submitPassword();
            else void submitPasskey();
          }}
        >
          {#if phase !== "passkey" || username.trim()}
            <div class="space-y-2">
            <Label for="username">Username</Label>
            <Input
              id="username"
              type="text"
              autocomplete="username"
              required
              bind:value={username}
              disabled={phase !== "username"}
            />
            </div>
          {/if}

          {#if phase === "password"}
            <div class="space-y-2">
              <Label for="password">Password</Label>
              <Input
                id="password"
                type="password"
                autocomplete="current-password"
                required
                bind:value={password}
              />
            </div>
          {/if}

          {#if phase === "passkey"}
            <p class="text-sm text-muted-foreground">
              Use your registered passkey to sign in{username.trim() ? " as " : ""}{#if username.trim()}<strong>{username}</strong>{/if}.
            </p>
          {/if}

          {#if autoPasskeyActive}
            <div class="flex w-full items-center justify-center gap-2 rounded-md border border-input bg-muted px-4 py-2 text-sm text-muted-foreground">
              <Fingerprint class="h-4 w-4" /> Waiting for passkey…
            </div>
          {:else}
            <Button type="submit" class="w-full" disabled={submitting || probing}>
              {#if phase === "username"}
                Continue
              {:else if phase === "password"}
                Sign in
              {:else}
                <Fingerprint class="h-4 w-4" /> Authenticate with passkey
              {/if}
            </Button>
          {/if}

          {#if phase !== "username"}
            <button
              type="button"
              class="block w-full text-center text-xs text-muted-foreground underline-offset-2 hover:underline"
              onclick={() => {
                phase = "username";
                password = "";
                error = null;
              }}
            >
              Use a different username
            </button>
          {/if}

          {#if phase === "password" && passkeySupported}
            <Button
              type="button"
              variant="outline"
              class="w-full"
              onclick={() => {
                phase = "passkey";
              }}
            >
              <Fingerprint class="h-4 w-4" /> Use a passkey instead
            </Button>
          {/if}
        </form>
      </Card.Content>
    </Card.Root>

    <p class="mt-6 text-center text-xs text-muted-foreground">
      Need help? Visit the
      <a class="underline-offset-2 hover:underline" href={`${base}/manual`}>manual</a>.
    </p>
  </div>
</div>
