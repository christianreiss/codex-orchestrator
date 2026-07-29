import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { afterEach, describe, it } from "node:test";

import type { PasskeyRegistrationOptionsJSON } from "$lib/api/types";
import type { PublicKeyAuthenticationOptionsJSON } from "./webauthn";

// The hand-rolled fallback only runs when `@simplewebauthn/browser` cannot be
// loaded, which never happens in a normal install — so make the specifier
// unresolvable for the whole file and every call takes the fallback path.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@simplewebauthn/browser") {
      throw new Error("Cannot find package '@simplewebauthn/browser'");
    }
    return nextResolve(specifier, context);
  },
});

// `node --test` strips types but resolves specifiers verbatim, so the runtime
// import needs the ".ts" extension that TypeScript rejects on a static import;
// hiding it behind a variable keeps both happy. Types come from the cast.
const webauthnModule: string = "./webauthn.ts";
const { authenticatePasskey, base64UrlToBuffer, bufferToBase64Url, registerPasskey } =
  (await import(webauthnModule)) as typeof import("./webauthn");

function bytesOf(buffer: BufferSource | undefined): number[] {
  assert.ok(buffer instanceof ArrayBuffer, "expected a decoded ArrayBuffer");
  return [...new Uint8Array(buffer)];
}

describe("base64url codec", () => {
  // Byte lengths 0…5 cover every base64url string length mod 4 that can occur
  // (0, 2 and 3 — a length of 1 mod 4 is not a valid encoding).
  const roundTrips: Array<{ bytes: number[]; encoded: string }> = [
    { bytes: [], encoded: "" },
    { bytes: [0x00], encoded: "AA" },
    { bytes: [0x00, 0x25], encoded: "ACU" },
    { bytes: [0x00, 0x25, 0x4a], encoded: "ACVK" },
    { bytes: [0x00, 0x25, 0x4a, 0x6f], encoded: "ACVKbw" },
    { bytes: [0x00, 0x25, 0x4a, 0x6f, 0x94], encoded: "ACVKb5Q" },
    // Standard base64 would spell these "+/8=" and "+/8A".
    { bytes: [0xfb, 0xff], encoded: "-_8" },
    { bytes: [0xfb, 0xff, 0x00], encoded: "-_8A" },
  ];

  for (const { bytes, encoded } of roundTrips) {
    it(`round-trips ${bytes.length} byte(s) as "${encoded}" (length ${encoded.length % 4} mod 4)`, () => {
      assert.equal(bufferToBase64Url(Uint8Array.from(bytes).buffer), encoded);
      assert.deepEqual(bytesOf(base64UrlToBuffer(encoded)), bytes);
    });
  }

  it("decodes the url-safe alphabet without padding", () => {
    assert.deepEqual(bytesOf(base64UrlToBuffer("-_w")), [0xfb, 0xfc]);
    assert.deepEqual(bytesOf(base64UrlToBuffer("-_8AEJ5_vg")), [
      0xfb, 0xff, 0x00, 0x10, 0x9e, 0x7f, 0xbe,
    ]);
  });

  it("emits no padding and neither '+' nor '/'", () => {
    // Every byte in every position that can carry the 62nd/63rd sextet.
    for (let value = 0; value < 256; value++) {
      for (let length = 1; length <= 3; length++) {
        const bytes = Uint8Array.from({ length }, () => value);
        const encoded = bufferToBase64Url(bytes.buffer);
        assert.match(encoded, /^[A-Za-z0-9_-]*$/, `unexpected characters in "${encoded}"`);
        assert.deepEqual(bytesOf(base64UrlToBuffer(encoded)), [...bytes]);
      }
    }
  });
});

// ---------- Fallback: navigator.credentials plumbing ----------

const realNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");

type CredentialsStub = {
  create?: (options: CredentialCreationOptions) => Promise<Credential | null>;
  get?: (options: CredentialRequestOptions) => Promise<Credential | null>;
};

/** Install `navigator.credentials`, or a bare `navigator` when omitted. */
function stubNavigator(credentials?: CredentialsStub): void {
  Object.defineProperty(globalThis, "navigator", {
    value: credentials ? { credentials } : {},
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  if (realNavigator) {
    Object.defineProperty(globalThis, "navigator", realNavigator);
  } else {
    delete (globalThis as { navigator?: Navigator }).navigator;
  }
});

const registrationOptions: PasskeyRegistrationOptionsJSON = {
  challenge: "-_8AEJ5_vg",
  rp: { id: "example.test", name: "Orchestrator" },
  user: { id: "AQID", name: "ada", displayName: "Ada" },
  pubKeyCredParams: [{ type: "public-key", alg: -7 }],
  timeout: 60_000,
  excludeCredentials: [{ type: "public-key", id: "3q2-7w", transports: ["usb"] }],
};

const authenticationOptions: PublicKeyAuthenticationOptionsJSON = {
  challenge: "-_8AEJ5_vg",
  rpId: "example.test",
  timeout: 60_000,
  userVerification: "preferred",
  allowCredentials: [{ type: "public-key", id: "3q2-7w", transports: ["usb"] }],
};

function buffer(bytes: number[]): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

/** A `PublicKeyCredential` shaped like the one an authenticator hands back. */
function fakeCredential(response: Record<string, unknown>): Credential {
  return {
    id: "3q2-7w",
    rawId: buffer([0xde, 0xad, 0xbe, 0xef]),
    type: "public-key",
    authenticatorAttachment: "platform",
    getClientExtensionResults: () => ({ credProps: { rk: true } }),
    response,
  } as unknown as Credential;
}

describe("registerPasskey fallback", () => {
  it("passes decoded buffers to navigator.credentials.create", async () => {
    let seen: CredentialCreationOptions | null = null;
    stubNavigator({
      create: async (options) => {
        seen = options;
        return fakeCredential({
          clientDataJSON: buffer([0x00, 0x25, 0x4a]),
          attestationObject: buffer([0xfb, 0xff]),
          getTransports: () => ["internal", "hybrid"],
        });
      },
    });

    await registerPasskey(registrationOptions);

    const publicKey = (seen as unknown as CredentialCreationOptions)
      .publicKey as PublicKeyCredentialCreationOptions;
    assert.deepEqual(bytesOf(publicKey.challenge), [0xfb, 0xff, 0x00, 0x10, 0x9e, 0x7f, 0xbe]);
    assert.deepEqual(bytesOf(publicKey.user.id), [0x01, 0x02, 0x03]);
    assert.deepEqual(bytesOf(publicKey.excludeCredentials?.[0].id), [0xde, 0xad, 0xbe, 0xef]);
    assert.deepEqual(publicKey.excludeCredentials?.[0].transports, ["usb"]);
    // The rest of the options ride through untouched, with `attestation`
    // defaulted because the server left it out.
    assert.deepEqual(publicKey.rp, registrationOptions.rp);
    assert.deepEqual(publicKey.pubKeyCredParams, registrationOptions.pubKeyCredParams);
    assert.equal(publicKey.timeout, 60_000);
    assert.equal(publicKey.attestation, "none");
  });

  it("returns the attestation as base64url JSON", async () => {
    stubNavigator({
      create: async () =>
        fakeCredential({
          clientDataJSON: buffer([0x00, 0x25, 0x4a]),
          attestationObject: buffer([0xfb, 0xff]),
          getTransports: () => ["internal", "hybrid"],
        }),
    });

    assert.deepEqual(await registerPasskey(registrationOptions), {
      id: "3q2-7w",
      rawId: "3q2-7w",
      type: "public-key",
      clientExtensionResults: { credProps: { rk: true } },
      authenticatorAttachment: "platform",
      response: {
        clientDataJSON: "ACVK",
        attestationObject: "-_8",
        transports: ["internal", "hybrid"],
      },
    });
  });

  it("omits transports when the authenticator does not report them", async () => {
    stubNavigator({
      create: async () =>
        fakeCredential({
          clientDataJSON: buffer([0x00, 0x25, 0x4a]),
          attestationObject: buffer([0xfb, 0xff]),
        }),
    });

    const result = await registerPasskey(registrationOptions);
    assert.equal(result.response.transports, undefined);
  });

  it("throws when the user cancels", async () => {
    stubNavigator({ create: async () => null });
    await assert.rejects(registerPasskey(registrationOptions), {
      message: "Registration cancelled",
    });
  });

  it("throws when navigator.credentials is missing", async () => {
    stubNavigator();
    await assert.rejects(registerPasskey(registrationOptions), {
      message: "WebAuthn is not supported in this browser",
    });
  });
});

describe("authenticatePasskey fallback", () => {
  it("passes decoded buffers to navigator.credentials.get", async () => {
    let seen: CredentialRequestOptions | null = null;
    stubNavigator({
      get: async (options) => {
        seen = options;
        return fakeCredential({
          authenticatorData: buffer([0x00, 0x25, 0x4a, 0x6f]),
          clientDataJSON: buffer([0x00, 0x25, 0x4a]),
          signature: buffer([0xfb, 0xff]),
          userHandle: null,
        });
      },
    });

    await authenticatePasskey(authenticationOptions);

    const publicKey = (seen as unknown as CredentialRequestOptions)
      .publicKey as PublicKeyCredentialRequestOptions;
    assert.deepEqual(bytesOf(publicKey.challenge), [0xfb, 0xff, 0x00, 0x10, 0x9e, 0x7f, 0xbe]);
    assert.deepEqual(bytesOf(publicKey.allowCredentials?.[0].id), [0xde, 0xad, 0xbe, 0xef]);
    assert.deepEqual(publicKey.allowCredentials?.[0].transports, ["usb"]);
    assert.equal(publicKey.rpId, "example.test");
    assert.equal(publicKey.userVerification, "preferred");
    assert.equal(publicKey.timeout, 60_000);
  });

  it("returns the assertion as base64url JSON, without userHandle when absent", async () => {
    stubNavigator({
      get: async () =>
        fakeCredential({
          authenticatorData: buffer([0x00, 0x25, 0x4a, 0x6f]),
          clientDataJSON: buffer([0x00, 0x25, 0x4a]),
          signature: buffer([0xfb, 0xff]),
          userHandle: null,
        }),
    });

    const result = await authenticatePasskey(authenticationOptions);
    assert.deepEqual(result, {
      id: "3q2-7w",
      rawId: "3q2-7w",
      type: "public-key",
      clientExtensionResults: { credProps: { rk: true } },
      authenticatorAttachment: "platform",
      response: {
        authenticatorData: "ACVKbw",
        clientDataJSON: "ACVK",
        signature: "-_8",
      },
    });
    assert.ok(!("userHandle" in result.response));
  });

  it("encodes userHandle when the assertion supplies one", async () => {
    stubNavigator({
      get: async () =>
        fakeCredential({
          authenticatorData: buffer([0x00, 0x25, 0x4a, 0x6f]),
          clientDataJSON: buffer([0x00, 0x25, 0x4a]),
          signature: buffer([0xfb, 0xff]),
          userHandle: buffer([0x01, 0x02, 0x03]),
        }),
    });

    const result = await authenticatePasskey(authenticationOptions);
    assert.equal(result.response.userHandle, "AQID");
  });

  it("throws when the user cancels", async () => {
    stubNavigator({ get: async () => null });
    await assert.rejects(authenticatePasskey(authenticationOptions), {
      message: "Authentication cancelled",
    });
  });

  it("throws when navigator.credentials is missing", async () => {
    stubNavigator();
    await assert.rejects(authenticatePasskey(authenticationOptions), {
      message: "WebAuthn is not supported in this browser",
    });
  });
});
