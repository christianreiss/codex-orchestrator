import type { SetupStep } from "$lib/api/setup";

export const STEP_LABELS: Record<SetupStep, string> = {
  infrastructure: "Infrastructure",
  owner: "Owner",
  engines: "Engines",
  auth: "Credentials",
  defaults: "Fleet defaults",
  policy: "Agent policy",
  modules: "Modules",
  collaboration: "Collaboration",
  host: "First host",
};

export interface StepMetaContext {
  ownerCreated: boolean;
  /** The credentials step has something typed that Next will save. */
  authHasInput: boolean;
  collabLabel?: string;
  /** A hostname is typed and not yet registered. */
  hostHasInput: boolean;
}

export interface StepMeta {
  title: string;
  description: string;
  skippable: boolean;
  nextLabel: string;
}

/** Heading, purpose and button wording for each wizard step. */
export function stepMeta(step: SetupStep, ctx: StepMetaContext): StepMeta {
  switch (step) {
    case "infrastructure":
      return { title: "Infrastructure", description: "Everything the console needs before it can be configured.", skippable: false, nextLabel: "Continue" };
    case "owner":
      return {
        title: "Create the first owner",
        description: "Your admin account. Creating it also signs you in.",
        skippable: false,
        nextLabel: ctx.ownerCreated ? "Continue" : "Create owner",
      };
    case "engines":
      return { title: "Which engines will this fleet run?", description: "Decides which credentials to ask for next.", skippable: true, nextLabel: "Save and continue" };
    case "auth":
      return {
        title: "Provider credentials",
        description: "One credential per engine, checked with the provider before it is stored.",
        skippable: true,
        nextLabel: ctx.authHasInput ? "Save and continue" : "Continue",
      };
    case "defaults":
      return {
        title: "Fleet defaults",
        description: "Model and effort for every managed host, and the write that turns MCP on.",
        skippable: true,
        nextLabel: "Save and continue",
      };
    case "policy":
      return { title: "Agent policy", description: "What every agent in this fleet is told before it starts work.", skippable: true, nextLabel: "Save and continue" };
    case "modules":
      return { title: "Optional modules", description: "Shared capabilities agents reach over MCP.", skippable: true, nextLabel: "Save and continue" };
    case "collaboration":
      return {
        title: "Collaboration",
        description: "How humans and agents reach each other. Both are off by default.",
        skippable: true,
        nextLabel: ctx.collabLabel ?? "Save and continue",
      };
    case "host":
      return {
        title: "Register your first host",
        description: "Optional. The console works without one.",
        skippable: false,
        nextLabel: ctx.hostHasInput ? "Register host" : "Finish",
      };
  }
}
