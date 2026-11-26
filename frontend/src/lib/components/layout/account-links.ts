import KeyRound from "@lucide/svelte/icons/key-round";
import Palette from "@lucide/svelte/icons/palette";
import Smartphone from "@lucide/svelte/icons/smartphone";

/** The sections of the single /account page, as the user menu and mobile sheet link to them. */
export const ACCOUNT_LINKS = [
  { hash: "#security", label: "Password & passkeys", icon: KeyRound },
  { hash: "#appearance", label: "Appearance", icon: Palette },
  { hash: "#devices", label: "Companion devices", icon: Smartphone },
] as const;
