/**
 * WebAuthn registration helper.
 *
 * Prefers `@simplewebauthn/browser` for safety (handles all the base64url ↔
 * ArrayBuffer translation, JSON encoding, browser quirks). The hand-rolled
 * fallback below exists so the feature still functions if the package is
 * unavailable at runtime — the backend speaks base64url either way.
 */
import type { PasskeyRegistrationOptionsJSON } from "$lib/api/types";

export type PublicKeyCredentialJSON = {
  id: string;
  rawId: string;
  type: "public-key";
  clientExtensionResults: Record<string, unknown>;
  authenticatorAttachment?: string | null;
  response: {
    clientDataJSON: string;
    attestationObject: string;
    transports?: string[];
  };
};

export type PublicKeyAuthenticationOptionsJSON = Omit<
  PublicKeyCredentialRequestOptions,
  "challenge" | "allowCredentials"
> & {
  challenge: string;
  allowCredentials?: Array<
    Omit<PublicKeyCredentialDescriptor, "id"> & { id: string }
  >;
};

export type PublicKeyAuthenticationJSON = {
  id: string;
  rawId: string;
  type: "public-key";
  clientExtensionResults: Record<string, unknown>;
  authenticatorAttachment?: string | null;
  response: {
    authenticatorData: string;
    clientDataJSON: string;
    signature: string;
    userHandle?: string;
  };
};

export async function registerPasskey(
  options: PasskeyRegistrationOptionsJSON,
): Promise<PublicKeyCredentialJSON> {
  let mod: typeof import("@simplewebauthn/browser") | null = null;
  try {
    mod = await import("@simplewebauthn/browser");
  } catch {
    // Package missing at runtime — use hand-rolled fallback.
    return handRolledRegister(options);
  }
  // v13+ signature: { optionsJSON: ... }
  const result = await mod.startRegistration({
    optionsJSON: options as Parameters<typeof mod.startRegistration>[0]["optionsJSON"],
  });
  return result as unknown as PublicKeyCredentialJSON;
}

export async function authenticatePasskey(
  options: PublicKeyAuthenticationOptionsJSON,
): Promise<PublicKeyAuthenticationJSON> {
  let mod: typeof import("@simplewebauthn/browser") | null = null;
  try {
    mod = await import("@simplewebauthn/browser");
  } catch {
    return handRolledAuthenticate(options);
  }
  const result = await mod.startAuthentication({
    optionsJSON: options as Parameters<typeof mod.startAuthentication>[0]["optionsJSON"],
  });
  return result as unknown as PublicKeyAuthenticationJSON;
}

// ---------- Fallback helpers (base64url ↔ ArrayBuffer) ----------

export function base64UrlToBuffer(str: string): ArrayBuffer {
  const padding = "=".repeat((4 - (str.length % 4)) % 4);
  const base64 = (str + padding).replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export function bufferToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function handRolledRegister(
  options: PasskeyRegistrationOptionsJSON,
): Promise<PublicKeyCredentialJSON> {
  if (typeof navigator === "undefined" || !navigator.credentials || !("create" in navigator.credentials)) {
    throw new Error("WebAuthn is not supported in this browser");
  }

  const publicKey: PublicKeyCredentialCreationOptions = {
    challenge: base64UrlToBuffer(options.challenge),
    rp: options.rp,
    user: {
      id: base64UrlToBuffer(options.user.id),
      name: options.user.name,
      displayName: options.user.displayName,
    },
    pubKeyCredParams: options.pubKeyCredParams,
    timeout: options.timeout,
    attestation: (options.attestation as AttestationConveyancePreference | undefined) ?? "none",
    authenticatorSelection: options.authenticatorSelection as
      | AuthenticatorSelectionCriteria
      | undefined,
    excludeCredentials: options.excludeCredentials?.map((c) => ({
      type: c.type,
      id: base64UrlToBuffer(c.id),
      transports: c.transports as AuthenticatorTransport[] | undefined,
    })),
  };

  const credential = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null;
  if (!credential) {
    throw new Error("Registration cancelled");
  }

  const response = credential.response as AuthenticatorAttestationResponse;
  const transports =
    typeof response.getTransports === "function" ? response.getTransports() : undefined;

  return {
    id: credential.id,
    rawId: bufferToBase64Url(credential.rawId),
    type: "public-key",
    clientExtensionResults: (credential.getClientExtensionResults?.() ??
      {}) as unknown as Record<string, unknown>,
    authenticatorAttachment: credential.authenticatorAttachment ?? null,
    response: {
      clientDataJSON: bufferToBase64Url(response.clientDataJSON),
      attestationObject: bufferToBase64Url(response.attestationObject),
      transports,
    },
  };
}

async function handRolledAuthenticate(
  options: PublicKeyAuthenticationOptionsJSON,
): Promise<PublicKeyAuthenticationJSON> {
  if (typeof navigator === "undefined" || !navigator.credentials || !("get" in navigator.credentials)) {
    throw new Error("WebAuthn is not supported in this browser");
  }

  const publicKey: PublicKeyCredentialRequestOptions = {
    challenge: base64UrlToBuffer(options.challenge),
    timeout: options.timeout,
    rpId: options.rpId,
    userVerification: options.userVerification,
    allowCredentials: options.allowCredentials?.map((c) => ({
      type: c.type,
      id: base64UrlToBuffer(c.id),
      transports: c.transports as AuthenticatorTransport[] | undefined,
    })),
  };

  const credential = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null;
  if (!credential) {
    throw new Error("Authentication cancelled");
  }

  const response = credential.response as AuthenticatorAssertionResponse;
  const out: PublicKeyAuthenticationJSON = {
    id: credential.id,
    rawId: bufferToBase64Url(credential.rawId),
    type: "public-key",
    clientExtensionResults: (credential.getClientExtensionResults?.() ??
      {}) as unknown as Record<string, unknown>,
    authenticatorAttachment: credential.authenticatorAttachment ?? null,
    response: {
      authenticatorData: bufferToBase64Url(response.authenticatorData),
      clientDataJSON: bufferToBase64Url(response.clientDataJSON),
      signature: bufferToBase64Url(response.signature),
    },
  };
  if (response.userHandle) {
    out.response.userHandle = bufferToBase64Url(response.userHandle);
  }
  return out;
}
