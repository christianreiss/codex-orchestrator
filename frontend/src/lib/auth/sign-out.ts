import { goto } from "$app/navigation";
import { base } from "$app/paths";
import { toast } from "svelte-sonner";
import { authActions } from "$lib/stores/auth";

export async function signOut(): Promise<void> {
  try {
    await authActions.logout();
  } catch {
    toast.error("Could not confirm sign-out", {
      description: "Check your connection and try signing out again.",
    });
    return;
  }
  await goto(`${base}/login`);
}
