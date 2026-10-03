import assert from "node:assert/strict";
import { describe, it } from "node:test";

// `node --test` strips types but resolves specifiers verbatim, so the runtime
// import needs the ".ts" extension that TypeScript rejects on a static import;
// hiding it behind a variable keeps both happy. Types come from the cast.
const consequencesModule: string = "./engine-switch-consequences.ts";
const { engineSwitchConfirmCopy } = (await import(
  consequencesModule
)) as typeof import("./engine-switch-consequences");
type EngineSwitchContext = import("./engine-switch-consequences").EngineSwitchContext;

const ctx = (overrides: Partial<EngineSwitchContext> = {}): EngineSwitchContext => ({
  label: "Grok",
  command: "cgx",
  activeHosts: 4,
  routedApis: [],
  lastEnabled: false,
  ...overrides,
});

describe("engineSwitchConfirmCopy", () => {
  it("styles only the disable direction as destructive", () => {
    assert.equal(engineSwitchConfirmCopy(true, ctx()).destructive, false);
    assert.equal(engineSwitchConfirmCopy(false, ctx()).destructive, true);
    assert.equal(engineSwitchConfirmCopy(true, ctx()).title, "Enable Grok for the fleet");
    assert.equal(engineSwitchConfirmCopy(false, ctx()).title, "Disable Grok for the fleet");
    assert.equal(engineSwitchConfirmCopy(false, ctx()).confirmLabel, "Disable Grok");
    assert.equal(engineSwitchConfirmCopy(true, ctx()).confirmLabel, "Enable Grok");
  });

  it("counts the active hosts that carry the engine, and drops the number rather than guess", () => {
    const text = (activeHosts: number | null) => engineSwitchConfirmCopy(false, ctx({ activeHosts })).consequences[0]!;
    assert.match(text(4), /the 4 active hosts that carry Grok/);
    assert.match(text(1), /the 1 active host that carries Grok/);
    const unknown = text(null);
    assert.match(unknown, /every active host that carries Grok/);
    assert.doesNotMatch(unknown, /null/);
    // Enabling agrees its verb with the subject.
    assert.match(engineSwitchConfirmCopy(true, ctx({ activeHosts: 4 })).consequences[0]!, /^The 4 active hosts that carry Grok resume cgx/);
    assert.match(engineSwitchConfirmCopy(true, ctx({ activeHosts: 1 })).consequences[0]!, /^The 1 active host that carries Grok resumes cgx/);
    assert.match(engineSwitchConfirmCopy(true, ctx({ activeHosts: null })).consequences[0]!, /^Every active host that carries Grok resumes cgx/);
  });

  it("says disabling suspends hosts without killing running sessions or deleting anything", () => {
    const copy = engineSwitchConfirmCopy(false, ctx());
    const text = [copy.description, ...copy.consequences].join("\n");
    assert.match(text, /cgx refuses to launch/);
    assert.match(text, /not killed/);
    assert.match(text, /no new account lease/);
    assert.match(text, /Nothing is uninstalled and no credentials are deleted/);
    assert.match(text, /stops token refresh, verification and quota polling/);
    assert.match(text, /configuration stay editable/);
  });

  it("warns about re-seeding after a long pause in both directions", () => {
    assert.match(engineSwitchConfirmCopy(false, ctx()).consequences.join("\n"), /re-seeded/);
    assert.match(engineSwitchConfirmCopy(true, ctx()).consequences.join("\n"), /re-seeded/);
  });

  it("tells the operator enabling resumes on next launch or within 15 minutes", () => {
    const copy = engineSwitchConfirmCopy(true, ctx());
    assert.match(copy.consequences.join("\n"), /next launch, or within 15 minutes/);
    assert.match(copy.description, /without a reinstall/);
  });

  it("names the exposed APIs routed to the engine, and says so when there are none", () => {
    const one = engineSwitchConfirmCopy(false, ctx({ routedApis: ["/grok/v1"] })).consequences.join("\n");
    assert.match(one, /\/grok\/v1 answers 503 while its backend is Grok/);
    const two = engineSwitchConfirmCopy(false, ctx({ routedApis: ["/v1", "/grok/v1"] })).consequences.join("\n");
    assert.match(two, /\/v1 and \/grok\/v1 answer 503 while their backend is Grok/);
    const none = engineSwitchConfirmCopy(false, ctx({ routedApis: [] })).consequences.join("\n");
    assert.match(none, /No exposed API is routed to Grok/);
    assert.match(engineSwitchConfirmCopy(true, ctx({ routedApis: ["/grok/v1"] })).consequences.join("\n"), /\/grok\/v1 answers again/);
    // Unknown (surfaces still loading): never claim there are none.
    const unknown = engineSwitchConfirmCopy(false, ctx({ routedApis: null })).consequences.join("\n");
    assert.match(unknown, /Any exposed API whose backend is Grok answers 503/);
    assert.doesNotMatch(unknown, /No exposed API/);
  });

  it("escalates only when turning off the last enabled engine", () => {
    assert.equal(engineSwitchConfirmCopy(false, ctx()).warning, null);
    const last = engineSwitchConfirmCopy(false, ctx({ lastEnabled: true }));
    assert.match(last.warning ?? "", /last enabled engine/);
    assert.match(last.warning ?? "", /admin console keeps working/);
    assert.equal(last.confirmLabel, "Turn off every engine");
    // The flag is meaningless when enabling.
    assert.equal(engineSwitchConfirmCopy(true, ctx({ lastEnabled: true })).warning, null);
  });
});
